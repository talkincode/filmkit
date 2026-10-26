// Three.js engine: HyperFrames renders the generated project (headless Chrome, WebGL).
// A PNG sequence is rendered, not an mp4, so frame i is exactly time i/fps and every
// keyframe still is lossless; blockout encodes the video itself with the same ffmpeg
// settings as the Blender path.

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, toolFailure } from "../errors.ts";
import { run, runOk, tail } from "../exec.ts";
import { checkFrames, pixelHash } from "../media.ts";
import { findHyperframes, type Hyperframes } from "../tools.ts";
import type { LoadedScene } from "../scene.ts";
import { HYPERFRAMES_PIN } from "../version.ts";
import { threeProjectFiles, writeProject } from "./three-project.ts";
import { SEEK_SKIPPED, seekFrames, type EngineRender } from "./types.ts";

export interface ThreeOptions {
  hyperframes?: string;
  seekSamples: number;
}

/** Writes the project under `projectDir` and returns it (no rendering). */
export function writeThreeProject(loaded: LoadedScene, projectDir: string) {
  const { files, vendor } = threeProjectFiles(loaded);
  writeProject(projectDir, files);
  return { files, vendor };
}

const frameName = (f: number) => `frame_${String(f + 1).padStart(6, "0")}.png`;

async function hf(h: Hyperframes, args: string[], cwd: string, what: string) {
  return runOk([...h.argv, ...args], what, { cwd, timeout: 15 * 60_000 });
}

export async function renderThree(loaded: LoadedScene, stage: string, opts: ThreeOptions): Promise<EngineRender> {
  const { fps, durationFrames } = loaded.scene.timing;
  const { width, height } = loaded.compiled;
  const projectDir = join(stage, "source", "three");
  const work = join(stage, "work", "three");
  mkdirSync(work, { recursive: true });
  const { vendor } = writeThreeProject(loaded, projectDir);
  const h = await findHyperframes({ explicit: opts.hyperframes, projectDir });

  const seqDir = join(work, "frames");
  await hf(h, ["render", projectDir, "--format", "png-sequence", "--fps", String(fps), "--output", seqDir, "--quiet"], projectDir, "hyperframes render (reference sequence)");
  const names = readdirSync(seqDir).filter((n) => /^frame_\d+\.png$/.test(n));
  if (names.length !== durationFrames) {
    return fail(toolFailure(`HyperFrames rendered ${names.length} frames, the scene declares ${durationFrames}`, { hint: `fps ${fps}, duration ${durationFrames / fps}s` }));
  }
  const framePath = (f: number) => join(seqDir, frameName(f));
  checkFrames(framePath, durationFrames, width, height, "hyperframes render");

  const ovDir = join(work, "overview");
  await hf(h, ["render", projectDir, "--composition", "compositions/overview.html", "--format", "png-sequence", "--fps", String(fps), "--output", ovDir, "--quiet"], projectDir, "hyperframes render (overview)");
  const overviewPath = join(ovDir, frameName(0));
  checkFrames(() => overviewPath, 1, width, height, "hyperframes render (overview)");

  // random access: snapshot exact instants in a shuffled order and compare with the sequence
  const visit = seekFrames(loaded.sha256, durationFrames, opts.seekSamples);
  let identical = true;
  if (visit.length) {
    const snapDir = join(work, "seek");
    const at = visit.map((f) => String(f / fps)).join(",");
    await hf(h, ["snapshot", projectDir, "--at", at, "--no-end", "--output", snapDir, "--json"], projectDir, "hyperframes snapshot (random seek)");
    const shots = readdirSync(snapDir).filter((n) => /^frame-\d+-at-.*\.png$/.test(n)).sort();
    if (shots.length !== visit.length) {
      return fail(toolFailure(`hyperframes snapshot produced ${shots.length} stills for ${visit.length} requested instants`));
    }
    for (const [k, f] of visit.entries()) {
      // snapshot names carry the request order as frame-<k>-
      const shot = shots.find((n) => n.startsWith(`frame-${String(k).padStart(2, "0")}-`))!;
      if ((await pixelHash(join(snapDir, shot))) !== (await pixelHash(framePath(f)))) {
        identical = false;
        break;
      }
    }
  }
  if (!identical) return fail(toolFailure("seeking out of order gave different pixels than the sequential render", { hint: "the Three.js page must be a pure function of time; run `blockout eval` to compare states" }));

  return {
    name: "three",
    version: vendor.version,
    renderer: `hyperframes@${h.version} + three@${vendor.version} (WebGL)`,
    pins: {
      three: vendor.version,
      "three.module.min.js": vendor.files["three.module.min.js"]!,
      "three.core.min.js": vendor.files["three.core.min.js"]!,
      hyperframes: h.version,
      hyperframesTested: HYPERFRAMES_PIN,
    },
    framePath,
    sequence: { pattern: join(seqDir, "frame_%06d.png"), startNumber: 1 },
    overviewPath,
    seek:
      visit.length === 0
        ? SEEK_SKIPPED
        : { status: "verified", frames: visit, identical, method: "hyperframes snapshot --at <t> (exact instant, requested out of order) vs the sequential png-sequence frame, decoded-pixel sha256" },
  };
}

/** `hyperframes check` on the generated project: HyperFrames validating its own native project. */
export async function checkThreeProject(projectDir: string, explicit?: string): Promise<{ version: string }> {
  const h = await findHyperframes({ explicit, projectDir });
  const r = await run([...h.argv, "check", projectDir, "--json"], { cwd: projectDir, timeout: 5 * 60_000 });
  if (r.status !== 0) {
    return fail(toolFailure("hyperframes check rejected the generated Three.js project", { hint: tail(`${r.stdout}\n${r.stderr}`, 20) }));
  }
  return { version: h.version };
}
