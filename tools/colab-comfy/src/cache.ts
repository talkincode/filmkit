// Project-local clip cache: <film dir>/.colab-comfy/cache/<k2>/<key>/{clip.mp4,meta.json}
// and the cache key (PLAN D7, §6.1).

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { bindInput, type Job } from "./job.ts";
import { bindWorkflow, type ResolvedRef, type Template, type Bound } from "./workflow.ts";

export const PROTOCOL = "colab-comfy/v1";
export const STATE_DIR = ".colab-comfy";

/**
 * key = sha256(canonical{protocol, manifestSha256, templateFileSha256, workflow}).
 * The workflow already carries content-hashed ref filenames and the constant
 * output prefix, so `pick`, `candidates` (for candidate 0), the GPU and the node
 * id never enter the key; prompt/seed/frames/resolution/sparsity/ref bytes do.
 */
export function cacheKey(tpl: Template, bound: Bound): string {
  return sha256Hex(
    canonicalJson({
      protocol: PROTOCOL,
      manifestSha256: tpl.manifestSha256,
      templateFileSha256: bound.templateFileSha256,
      workflow: bound.workflow,
    }),
  );
}

/** The one function batch and materialize both use, so their keys cannot diverge (PLAN §8.1 U*). */
export function jobCacheKey(tpl: Template, job: Job, candidate: number, refs: ResolvedRef[]): string {
  return cacheKey(tpl, bindWorkflow(tpl, bindInput(job, tpl), candidate, refs));
}

export interface CachePaths {
  dir: string;
  clip: string;
  meta: string;
}

export function cachePaths(baseDir: string, key: string): CachePaths {
  const dir = join(baseDir, STATE_DIR, "cache", key.slice(0, 2), key);
  return { dir, clip: join(dir, "clip.mp4"), meta: join(dir, "meta.json") };
}

/** A hit needs both files: the clip is only ever renamed into place after its meta is known good. */
export function cacheHit(baseDir: string, key: string): boolean {
  const p = cachePaths(baseDir, key);
  return existsSync(p.clip) && existsSync(p.meta);
}

/** Write to <path>.part, then rename; never leaves a half-written target. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  try {
    writeFileSync(part, data);
    renameSync(part, path);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}
