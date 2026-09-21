// `filmkit build`: normalize -> compose -> verify -> atomic move -> lock.
// Every ffmpeg invocation is planned first and written to
// build/compose.filtergraph.txt, then executed in order. Failure anywhere
// leaves the target output untouched and the lock unchanged (spec §6.2).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FilmkitError, invalid, missingDependency, toolFailure, type ErrorDetail } from "../errors.ts";
import { exec, execFailure } from "../exec.ts";
import { sha256File, sha256Text } from "../hash.ts";
import { emptyLock, writeLock } from "../lock.ts";
import { probeMedia } from "../probe.ts";
import { requireFilesPlaced, type Analysis } from "../project.ts";
import { toLockNode } from "../state.ts";
import type { Lock, Probe } from "../types.ts";
import { planCompose } from "./compose.ts";
import { geometryFor, PROBE_AUDIO_CODEC, PROBE_FORMAT, PROBE_VIDEO_CODEC, renderSteps, type FfmpegStep } from "./ffmpeg.ts";
import { planClips } from "./normalize.ts";
import { formatSrt, mergeCues, parseSrt } from "./subtitles.ts";

export interface BuildOptions {
  draft: boolean;
  /** Plan only: write compose.filtergraph.txt, run nothing. */
  dryRun?: boolean;
}

export interface BuildResult {
  output: string;
  filtergraph: string;
  subtitles?: string;
  total: number;
  draft: boolean;
  dryRun: boolean;
  warnings: string[];
  probe?: Probe;
}

export const FILTERGRAPH_PATH = "build/compose.filtergraph.txt";

export function build(a: Analysis, opts: BuildOptions): BuildResult {
  const { loaded } = a;
  const { film, dir } = loaded;
  const warnings: string[] = [];

  if (a.missingFiles.length) throw new FilmkitError(requireFilesPlaced(a));

  // Refuse to compose from an incomplete or stale set of produces.
  const notReady = a.order.filter((n) => a.state.nodes.get(n.id)!.status !== "ready" || a.blocked.has(n.id));
  if (notReady.length) {
    throw new FilmkitError(
      notReady.map((n) => invalid(`node "${n.id}" is ${a.blocked.has(n.id) ? "blocked" : a.state.nodes.get(n.id)!.status}; run \`filmkit plan\` and produce it first`)),
    );
  }

  const geo = geometryFor(film.output, opts.draft);
  const clips = planClips(a, geo);

  // ---- subtitles (merged in TypeScript, not ffmpeg) ----
  const subTrack = film.timeline.tracks.find((t) => t.kind === "subtitles");
  let subtitlePath: string | undefined;
  let mergedSrt: string | undefined;
  if (subTrack) {
    const inputs = a.timeline.scenes
      .filter((p) => p.scene.produces.subtitle)
      .map((p) => ({
        sceneId: p.scene.id,
        start: p.start,
        end: p.end,
        cues: parseSrt(readFileSync(resolve(dir, p.scene.produces.subtitle!), "utf8"), p.scene.produces.subtitle!),
      }));
    const merged = mergeCues(inputs);
    for (const d of merged.dropped) warnings.push(`subtitle cue in ${d.sceneId} at ${d.cue.start}s lies outside the scene and was dropped`);
    mergedSrt = formatSrt(merged.cues);
    const outPath = opts.draft ? film.output.path.replace(/\.([a-z0-9]+)$/, ".draft.$1") : film.output.path;
    subtitlePath = outPath.replace(/\.[a-z0-9]+$/, ".srt");
  }

  const compose = planCompose(a, geo, clips, {
    draft: opts.draft,
    subtitlePath,
    embedSubtitles: subTrack?.kind === "subtitles" && subTrack.mode === "embed",
  });

  const steps: FfmpegStep[] = [];
  for (const c of clips) {
    if (c.gap) steps.push(c.gap.step);
    steps.push(c.step);
  }
  steps.push(compose.step);
  const header = [
    `film: ${loaded.path}`,
    `output: ${compose.finalOutput} (${geo.width}x${geo.height}@${geo.fps}, ${opts.draft ? "draft" : "final"})`,
    `total: ${compose.total}s`,
  ];
  const filtergraphText = renderSteps(header, steps);

  mkdirSync(resolve(dir, "build/clips"), { recursive: true });
  mkdirSync(resolve(dir, "build/.tmp"), { recursive: true });
  writeFileSync(resolve(dir, FILTERGRAPH_PATH), filtergraphText, "utf8");
  // Filter scripts referenced by -filter_complex_script.
  for (const c of clips) {
    writeFileSync(resolve(dir, `build/clips/${c.scene.scene.id}.filter`), c.step.filterComplex + "\n", "utf8");
    if (c.gap) writeFileSync(resolve(dir, `build/clips/${c.scene.scene.id}.gap.filter`), c.gap.step.filterComplex + "\n", "utf8");
  }
  writeFileSync(resolve(dir, "build/compose.filter"), compose.step.filterComplex + "\n", "utf8");
  if (subtitlePath && mergedSrt !== undefined) {
    mkdirSync(dirname(resolve(dir, subtitlePath)), { recursive: true });
    writeFileSync(resolve(dir, subtitlePath), mergedSrt, "utf8");
  }

  const result: BuildResult = {
    output: compose.finalOutput,
    filtergraph: FILTERGRAPH_PATH,
    subtitles: subtitlePath,
    total: compose.total,
    draft: opts.draft,
    dryRun: Boolean(opts.dryRun),
    warnings,
  };
  if (opts.dryRun) return result;

  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) {
    throw new FilmkitError(missingDependency("ffmpeg and ffprobe are required for build", { hint: "run `filmkit doctor`" }));
  }
  const tmpAbs = resolve(dir, compose.tmpOutput);
  rmSync(tmpAbs, { force: true });
  try {
    for (const step of steps) {
      const r = exec(step.argv, { cwd: dir });
      if (r.status !== 0) throw new FilmkitError(execFailure(r, "tool-failure", step.title));
    }
    const probe = probeMedia(compose.tmpOutput, dir);
    if (!opts.draft) {
      const problems = verifyOutput(a, probe, compose.total);
      if (problems.length) throw new FilmkitError(problems);
    }
    const finalAbs = resolve(dir, compose.finalOutput);
    mkdirSync(dirname(finalAbs), { recursive: true });
    renameSync(tmpAbs, finalAbs);
    result.probe = probe;
  } catch (err) {
    rmSync(tmpAbs, { force: true });
    throw err;
  }

  // ---- lock ----
  const lock: Lock = a.state.lock ?? emptyLock(loaded.path, a.filmSha256);
  lock.film = { path: loaded.path, sha256: a.filmSha256 };
  for (const n of a.order) lock.nodes[n.id] = toLockNode(loaded, a.state.nodes.get(n.id)!);
  lock.timeline = {
    total: a.timeline.total,
    scenes: a.timeline.scenes.map((p) => ({ id: p.scene.id, start: p.start, end: p.end, duration: p.duration, estimated: p.estimated })),
  };
  lock.build = {
    filmSha256: a.filmSha256,
    output: { path: compose.finalOutput, sha256: sha256File(resolve(dir, compose.finalOutput)), probe: result.probe },
    filtergraph: { path: FILTERGRAPH_PATH, sha256: sha256Text(filtergraphText) },
    ffmpeg: { version: ffmpegVersion(dir) },
    draft: opts.draft,
  };
  writeLock(dir, lock);
  return result;
}

/** Compare ffprobe facts about the output with `output` (spec §1.6, §6.2). */
export function verifyOutput(a: Analysis, probe: Probe, expectedTotal: number): ErrorDetail[] {
  const out = a.loaded.film.output;
  const problems: ErrorDetail[] = [];
  const bad = (what: string, want: unknown, got: unknown) => problems.push(toolFailure(`output ${what}: expected ${want}, got ${got}`, { field: "output" }));
  if (probe.width !== out.video.width || probe.height !== out.video.height) bad("resolution", `${out.video.width}x${out.video.height}`, `${probe.width}x${probe.height}`);
  if (probe.fps === undefined || Math.abs(probe.fps - out.video.fps) > 0.01) bad("fps", out.video.fps, probe.fps);
  if (probe.videoCodec !== PROBE_VIDEO_CODEC[out.video.codec]) bad("video codec", PROBE_VIDEO_CODEC[out.video.codec], probe.videoCodec);
  if (probe.audioCodec !== PROBE_AUDIO_CODEC[out.audio.codec]) bad("audio codec", PROBE_AUDIO_CODEC[out.audio.codec], probe.audioCodec);
  if (probe.sampleRate !== out.audio.sampleRate) bad("sample rate", out.audio.sampleRate, probe.sampleRate);
  if (probe.channels !== out.audio.channels) bad("channels", out.audio.channels, probe.channels);
  if (probe.format !== PROBE_FORMAT[out.container]) bad("container", PROBE_FORMAT[out.container], probe.format);
  if (probe.duration === undefined || Math.abs(probe.duration - expectedTotal) > out.duration.tolerance) {
    bad(`duration (tolerance ${out.duration.tolerance}s)`, expectedTotal, probe.duration);
  }
  return problems;
}

export function ffmpegVersion(cwd: string): string {
  const r = exec(["ffmpeg", "-version"], { cwd });
  const m = /ffmpeg version (\S+)/.exec(r.stdout);
  return m?.[1] ?? "unknown";
}

export function readFiltergraph(dir: string): string | undefined {
  const p = resolve(dir, FILTERGRAPH_PATH);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}
