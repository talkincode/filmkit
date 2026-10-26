// Shared test scaffolding: scenes, temp dirs, a runner for the CLI, and tool discovery
// that says out loud when a real tool is missing instead of silently skipping.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliResult } from "../src/cli.ts";
import { blenderSearch } from "../src/tools.ts";
import type { BlockoutScene } from "../runtime/blockout-core.js";

export const EXAMPLE = join(import.meta.dir, "..", "examples", "handoff.json");

export function baseScene(over: Partial<BlockoutScene> = {}): BlockoutScene {
  return {
    apiVersion: "blockout/v1alpha1",
    kind: "BlockoutScene",
    id: "t",
    binding: { composition: { id: "c", revision: "1" }, shot: { id: "s", revision: "1" } },
    timing: { fps: 24, durationFrames: 24 },
    frame: { width: 160, height: 90 },
    environment: {
      floor: { size: [10, 10] },
      blocks: [{ id: "wall", shape: { type: "box", size: [2, 0.2, 2] }, pos: [0, -1, 1] }],
    },
    subjects: [
      {
        id: "ann", binding: { id: "char-ann", revision: "1" }, kind: "humanoid", height: 1.7,
        keyframes: [{ frame: 0, pos: [-3, 1, 0], rot: [0, 0, -90] }, { frame: 23, pos: [3, 1, 0] }],
      },
    ],
    camera: { keyframes: [{ frame: 0, pos: [0, -6, 1.6], target: [0, 0, 1.2], focalLength: 35 }] },
    ...over,
  };
}

export interface Sandbox {
  dir: string;
  path(rel: string): string;
  scene(name: string, scene: unknown): string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "blockout-test-"));
  return {
    dir,
    path: (rel) => join(dir, rel),
    scene(name, scene) {
      const p = join(dir, name);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, typeof scene === "string" ? scene : JSON.stringify(scene, null, 2));
      return p;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function cli(...args: string[]): Promise<CliResult> {
  return main(args);
}

export async function cliJson<T = unknown>(...args: string[]): Promise<{ exitCode: number; out?: T; err?: { errors: { code: string; message: string; field?: string; line?: number; hint?: string }[] } }> {
  const r = await main([...args, "--json"]);
  return { exitCode: r.exitCode, out: r.stdout ? (JSON.parse(r.stdout) as T) : undefined, err: r.stderr ? JSON.parse(r.stderr) : undefined };
}

/** Everything under `dir`, relative, sorted: used to prove a failure changed nothing. */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      out.push(`${prefix}${name}`);
      try {
        readdirSync(full);
        walk(full, `${prefix}${name}/`);
      } catch {
        /* a file */
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Real-tool gates. A missing tool is reported on stderr with what is not being tested, and
 * the suite adds an explicit test so the gap shows up in the results, not as silence.
 */
export function blenderPath(): string | undefined {
  return process.env.BLOCKOUT_TEST_BLENDER ?? blenderSearch().find((p) => existsSync(p));
}

export function hyperframesPath(): string | undefined {
  const candidates = [process.env.BLOCKOUT_HYPERFRAMES, Bun.which("hyperframes") ?? undefined, join(import.meta.dir, "..", "node_modules", ".bin", "hyperframes")];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

export function reportMissing(what: string, why: string): void {
  console.error(`[blockout tests] NOT RUN — ${what}: ${why}`);
}
