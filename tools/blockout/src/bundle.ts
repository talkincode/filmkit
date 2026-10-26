// The output bundle: reference video, overview, keyframe stills, source archive,
// manifest. Everything is produced in a staging directory next to the destination and
// moved into place only when all of it exists and verifies. A failure at any point
// leaves the destination exactly as it was found (no partial bundle, nothing
// overwritten); manifest.json lands last, so its presence means the bundle is whole.

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { analyze, type Analysis } from "./analysis.ts";
import { tarGz, type ArchiveEntry } from "./archive.ts";
import { renderBlender } from "./engines/blender.ts";
import { renderThree } from "./engines/three.ts";
import type { EngineRender } from "./engines/types.ts";
import { fail, io, toolFailure } from "./errors.ts";
import { killChildren } from "./exec.ts";
import { sha256Bytes, sha256File, sizeOf } from "./hash.ts";
import { encodeVideo, ffmpegVersion, probeVideo, type VideoFacts } from "./media.ts";
import type { LoadedScene } from "./scene.ts";
import { handoffGaps, stillFrames } from "./scene.ts";
import { MANIFEST_SCHEMA, TOOL_NAME, TOOL_VERSION } from "./version.ts";

export interface RenderOptions {
  engine: "blender" | "three";
  /** Destination directory: reference video, manifest, overview.png, keyframes/, source.tar.gz all live here. */
  dir: string;
  videoName: string;
  manifestName: string;
  force: boolean;
  blender?: string;
  hyperframes?: string;
  seekSamples: number;
  crf?: number;
}

export const FIXED = { overview: "overview.png", keyframes: "keyframes", archive: "source.tar.gz" } as const;
const MIME = { video: "video/mp4", png: "image/png", archive: "application/gzip" } as const;

export interface Artifact {
  role: "reference-video" | "overview" | "keyframe" | "source-archive";
  path: string;
  mime: string;
  size: number;
  sha256: string;
  /** "blockout-<sha256>": the content-addressed id consumers can use as the asset id (same bytes, same id). */
  assetId: string;
  use?: string[];
  frame?: number;
  timeSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  durationSeconds?: number;
  files?: { path: string; size: number; sha256: string }[];
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  tool: { name: string; version: string };
  purpose: { use: string[]; notFor: string[] };
  scene: { id: string; sha256: string };
  binding: Record<string, unknown>;
  /** Whether the declaration carries the complete binding an upstream hand-off needs, and what it lacks. */
  handoff: { complete: boolean; missing: string[] };
  engine: { name: string; version: string; renderer: string; pins: Record<string, string> };
  render: { width: number; height: number; fps: number; durationFrames: number; durationSeconds: number };
  artifacts: Artifact[];
  verification: {
    frames: { expected: number; images: number; video: number };
    video: { width: number; height: number; fps: number; codec: string; pixelFormat: string };
    seek: { status: "verified" | "skipped"; frames: number[]; identical: boolean | null; method: string; stateMaxError?: number };
  };
  analysis: Analysis;
}

// ───────────────────────── landing ─────────────────────────

export interface Hooks {
  /** Called after each item lands (tests use it to simulate a failure mid-landing). */
  afterLand?: (name: string, index: number) => void;
}

/** What finally exists in `dest`, in landing order (manifest last). */
export function targetsOf(opts: Pick<RenderOptions, "videoName" | "manifestName">): { name: string; dir: boolean }[] {
  return [
    { name: opts.videoName, dir: false },
    { name: FIXED.overview, dir: false },
    { name: FIXED.keyframes, dir: true },
    { name: FIXED.archive, dir: false },
    { name: opts.manifestName, dir: false },
  ];
}

function isEmptyDir(p: string): boolean {
  return statSync(p).isDirectory() && readdirSync(p).length === 0;
}

/** Refuse before doing any work if something is in the way (unless --force). */
export function checkNoConflicts(opts: Pick<RenderOptions, "dir" | "videoName" | "manifestName" | "force">): void {
  if (opts.force) return;
  const clash = targetsOf(opts)
    .map((t) => join(opts.dir, t.name))
    .filter((p) => existsSync(p) && !(statSync(p).isDirectory() && isEmptyDir(p)));
  if (clash.length) {
    fail(io(`refusing to overwrite: ${clash.map((p) => basename(p)).join(", ")} already exist in ${opts.dir}`, { hint: "pass --force to replace the bundle, or choose another --out" }));
  }
}

export function land(dest: string, stageOut: string, backupDir: string, names: { name: string; dir: boolean }[], force: boolean, hooks: Hooks = {}): void {
  const landed: string[] = [];
  const moved: [string, string][] = [];
  try {
    names.forEach((t, i) => {
      const final = join(dest, t.name);
      if (existsSync(final)) {
        if (t.dir && isEmptyDir(final)) rmdirSync(final);
        else if (!force) throw new Error(`${final} appeared while rendering`);
        else {
          mkdirSync(backupDir, { recursive: true });
          const saved = join(backupDir, t.name);
          renameSync(final, saved);
          moved.push([final, saved]);
        }
      }
      renameSync(join(stageOut, t.name), final);
      landed.push(final);
      hooks.afterLand?.(t.name, i);
    });
  } catch (err) {
    for (const p of landed.reverse()) rmSync(p, { recursive: true, force: true });
    for (const [final, saved] of moved.reverse()) renameSync(saved, final);
    fail(io(`could not place the bundle in ${dest}: ${(err as Error).message}`, { hint: "nothing was changed" }));
  }
}

// ───────────────────────── source archive ─────────────────────────

const EXCLUDE = [/^render\//, /\/render\//, /node_modules\//, /\.hyperframes\//, /__pycache__\//, /\.blend1$/, /\.DS_Store$/];

function collect(root: string, prefix: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split("\\").join("/");
      if (EXCLUDE.some((re) => re.test(rel + (statSync(full).isDirectory() ? "/" : "")))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: `${prefix}/${rel}`, data: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

export function sourceEntries(loaded: LoadedScene, sourceRoot: string, engine: "blender" | "three"): ArchiveEntry[] {
  const replay = {
    three: ["Three.js / HyperFrames project in three/.", "  npm install            # hyperframes (pinned in package.json); three is vendored in vendor/", "  npx hyperframes check", "  npx hyperframes render --format png-sequence --fps <fps> --output frames", ""],
    blender: ["Blender project in blender/.", "  blender -b blender/scene.blend -o //render/f_#### -a", "  blender -b blender/scene.blend -P blender/render_overview.py -- overview.png", ""],
  }[engine];
  return [
    { path: "source/scene.json", data: loaded.bytes },
    { path: "source/README.txt", data: new TextEncoder().encode([`blockout ${TOOL_VERSION} source for scene ${loaded.scene.id}`, "scene.json is the declaration exactly as given; the engine project below is derived from it.", ...replay].join("\n")) },
    ...collect(sourceRoot, "source"),
  ];
}

// ───────────────────────── manifest ─────────────────────────

/**
 * The manifest's binding: composition, shot and/or scene, environment (id/revision/variant as declared), and every
 * subject and prop with its upstream id, revision, variant (when declared), role (character | prop) and geometry kind.
 */
function binding(loaded: LoadedScene): Record<string, unknown> {
  const b = loaded.scene.binding;
  const entity = (id: string, e: { id: string; revision: string; variant?: string }, role: string, kind: string) => ({
    id, bindingId: e.id, revision: e.revision, ...(e.variant ? { variant: e.variant } : {}), role, kind,
  });
  return {
    composition: b.composition,
    ...(b.shot ? { shot: b.shot } : {}),
    ...(b.scene ? { scene: b.scene } : {}),
    ...(b.environment ? { environment: b.environment } : {}),
    subjects: (loaded.scene.subjects ?? []).map((s) => entity(s.id, s.binding, "character", s.kind)),
    props: (loaded.scene.props ?? []).map((p) => entity(p.id, p.binding, "prop", p.shape.type)),
  };
}

/** The round trip must not leak where it ran: no absolute path of this machine inside a delivered artifact. */
function assertNoLocalPaths(path: string, forbidden: string[]): void {
  const bytes = readFileSync(path).toString("latin1");
  for (const needle of forbidden) {
    if (needle && bytes.includes(needle)) fail(toolFailure(`${basename(path)} embeds a local path (${needle})`, { hint: "an engine wrote machine-specific metadata into the image" }));
  }
}

// ───────────────────────── the render pipeline ─────────────────────────

export async function renderBundle(loaded: LoadedScene, opts: RenderOptions, hooks: Hooks = {}): Promise<{ manifest: Manifest; manifestPath: string }> {
  const dest = resolve(opts.dir);
  checkNoConflicts({ ...opts, dir: dest });
  const ffmpeg = await ffmpegVersion();

  // directories this call creates: on failure they are removed again (deepest first, only while empty)
  const created: string[] = [];
  for (let d = dest; !existsSync(d); d = dirname(d)) created.push(d);
  mkdirSync(dest, { recursive: true });
  const stage = mkdtempSync(join(dest, ".blockout-staging-"));
  const cleanup = () => {
    rmSync(stage, { recursive: true, force: true });
    for (const d of created) {
      try {
        rmdirSync(d);
      } catch {
        break; // something else is in there; leave it and everything above it
      }
    }
  };
  const onSignal = (code: number) => () => {
    killChildren();
    cleanup();
    process.exit(code);
  };
  const sigint = onSignal(130);
  const sigterm = onSignal(143);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  try {
    const { fps, durationFrames } = loaded.scene.timing;
    const { width, height } = loaded.compiled;
    const eng: EngineRender =
      opts.engine === "blender"
        ? await renderBlender(loaded, stage, { blender: opts.blender, seekSamples: opts.seekSamples })
        : await renderThree(loaded, stage, { hyperframes: opts.hyperframes, seekSamples: opts.seekSamples });

    const out = join(stage, "out");
    mkdirSync(join(out, FIXED.keyframes), { recursive: true });

    // the video: one ffmpeg encode for both engines
    await encodeVideo({ pattern: eng.sequence.pattern, startNumber: eng.sequence.startNumber, fps, frames: durationFrames, out: join(out, opts.videoName), crf: opts.crf });
    const facts: VideoFacts = await probeVideo(join(out, opts.videoName));
    if (facts.frames !== durationFrames || facts.width !== width || facts.height !== height || Math.abs(facts.fps - fps) > 1e-6) {
      return fail(toolFailure(`the encoded video is ${facts.width}x${facts.height} @ ${facts.fps} fps with ${facts.frames} frames; the scene declares ${width}x${height} @ ${fps} fps with ${durationFrames}`));
    }

    // stills: copies of rendered frames, lossless
    copyFileSync(eng.overviewPath, join(out, FIXED.overview));
    const stills = stillFrames(loaded.scene);
    for (const f of stills) copyFileSync(eng.framePath(f), join(out, FIXED.keyframes, `kf-${String(f).padStart(4, "0")}.png`));
    const pngs = [join(out, FIXED.overview), ...stills.map((f) => join(out, FIXED.keyframes, `kf-${String(f).padStart(4, "0")}.png`))];
    for (const p of pngs) assertNoLocalPaths(p, [stage, dest, homedir()]);

    // source archive
    const entries = sourceEntries(loaded, join(stage, "source"), opts.engine);
    writeFileSync(join(out, FIXED.archive), tarGz(entries));

    const analysis = analyze(loaded.compiled);
    const artifacts: Artifact[] = [
      { role: "reference-video", path: opts.videoName, mime: MIME.video, size: 0, sha256: "", assetId: "", use: ["motion", "blocking"], width: facts.width, height: facts.height, fps: facts.fps, frames: facts.frames, durationSeconds: round4(facts.durationSeconds) },
      { role: "overview", path: FIXED.overview, mime: MIME.png, size: 0, sha256: "", assetId: "", use: ["blocking"] },
      ...stills.map((f): Artifact => ({ role: "keyframe", path: `${FIXED.keyframes}/kf-${String(f).padStart(4, "0")}.png`, frame: f, timeSeconds: round4(f / fps), mime: MIME.png, size: 0, sha256: "", assetId: "", use: ["blocking"] })),
      { role: "source-archive", path: FIXED.archive, mime: MIME.archive, size: 0, sha256: "", assetId: "", files: entries.map((e) => ({ path: e.path, size: e.data.length, sha256: sha256Bytes(e.data) })) },
    ];
    for (const a of artifacts) {
      a.size = sizeOf(join(out, a.path));
      a.sha256 = await sha256File(join(out, a.path));
      a.assetId = `blockout-${a.sha256}`;
    }

    const manifest: Manifest = {
      schema: MANIFEST_SCHEMA,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      purpose: { use: ["motion", "blocking"], notFor: ["identity", "first-frame"] },
      scene: { id: loaded.scene.id, sha256: loaded.sha256 },
      binding: binding(loaded),
      handoff: { complete: handoffGaps(loaded.scene).length === 0, missing: handoffGaps(loaded.scene) },
      engine: { name: eng.name, version: eng.version, renderer: eng.renderer, pins: { ...eng.pins, ffmpeg, blockoutProtocol: "blockout/v1alpha1" } },
      render: { width, height, fps, durationFrames, durationSeconds: round4(durationFrames / fps) },
      artifacts,
      verification: {
        frames: { expected: durationFrames, images: durationFrames, video: facts.frames },
        video: { width: facts.width, height: facts.height, fps: facts.fps, codec: facts.codec, pixelFormat: facts.pixelFormat },
        seek: eng.seek,
      },
      analysis,
    };
    writeFileSync(join(out, opts.manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

    land(dest, out, join(stage, "backup"), targetsOf(opts), opts.force, hooks);
    return { manifest, manifestPath: join(dest, opts.manifestName) };
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    cleanup();
  }
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
