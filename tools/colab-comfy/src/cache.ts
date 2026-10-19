// Project-local clip cache: <film dir>/.colab-comfy/cache/<k2>/<key>/{clip.mp4,meta.json}
// and the cache key (PLAN D7, §6.1).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { bindInput, type Job } from "./job.ts";
import { bindWorkflow, type ResolvedInputs, type Template, type Bound } from "./workflow.ts";

export const PROTOCOL = "colab-comfy/v1";
export const STATE_DIR = ".colab-comfy";

/**
 * key = sha256(canonical{protocol, manifestSha256, templateFileSha256, workflow}).
 * The workflow already carries content-hashed ref and audio filenames and the constant
 * output prefix, so `pick`, `candidates` (for candidate 0), the GPU and the node
 * id never enter the key; prompt/seed/frames/resolution/sparsity/ref bytes/audio bytes do.
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

/**
 * The one function batch and materialize both use, so their keys cannot diverge (PLAN §8.1 U*).
 * `workflowSha256` hashes the bound workflow (the exact ComfyUI API JSON, refs content-hashed) for run records.
 */
export function jobKeyInfo(tpl: Template, job: Job, candidate: number, inputs: ResolvedInputs): { key: string; workflowSha256: string; variant: Bound["variant"]; templateFileSha256: string } {
  const bound = bindWorkflow(tpl, bindInput(job, tpl), candidate, inputs);
  return { key: cacheKey(tpl, bound), workflowSha256: sha256Hex(canonicalJson(bound.workflow)), variant: bound.variant, templateFileSha256: bound.templateFileSha256 };
}

export function jobCacheKey(tpl: Template, job: Job, candidate: number, inputs: ResolvedInputs): string {
  return jobKeyInfo(tpl, job, candidate, inputs).key;
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

/** Session-level cost facts, attached to each downloaded clip's meta once the session is closed (src/session.ts). */
export interface CacheCost {
  session: string;
  estimateCU: number;
  usageBeforeCU: number;
  usageAfterCU: number | null;
  sessionActualCU: number | null;
  /** session CU x this candidate's gen seconds / all gen seconds of the session; null when usage was unavailable. */
  attributedCU: number | null;
  /** false: the balance had not settled after the stop, so the CU numbers are provisional (absent in old metas). */
  usageSettled?: boolean;
  stopped: boolean;
  sessionsVerifiedEmpty: boolean;
}

/** `.colab-comfy/cache/<k2>/<key>/meta.json`. Everything a run record needs comes from here (+ the node's params). */
export interface CacheMeta {
  key: string;
  node: string;
  candidate: number;
  seed: number;
  session: string;
  downloadedAt: string;
  job: { wallSec?: number | null; peakVramMiB?: number | null; [k: string]: unknown };
  env: {
    gpu?: { name?: string; driver?: string; memoryMiB?: number };
    python?: string;
    torch?: string;
    cuda?: string;
    comfyKitchen?: string;
    comfyui?: { repo?: string; commit?: string };
    customNodes?: { repo?: string; commit?: string }[];
    weights?: { repo?: string; file?: string; revision?: string; sha256?: string; bytes?: number }[];
  } | null;
  video: { sha256: string; bytes: number };
  cost?: CacheCost;
}

export function readMeta(baseDir: string, key: string): CacheMeta {
  const p = cachePaths(baseDir, key).meta;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as CacheMeta;
    if (m?.video?.sha256 === undefined || typeof m.video.bytes !== "number") throw new Error("meta.json has no video sha256/bytes");
    return m;
  } catch (err) {
    throw new Error(`cache entry ${key.slice(0, 12)} is unreadable (${p}): ${(err as Error).message}`);
  }
}

/** Rewrite meta.json with `cost` (atomic). The clip itself is never touched. */
export function attachCost(baseDir: string, key: string, cost: CacheCost): void {
  writeFileAtomic(cachePaths(baseDir, key).meta, JSON.stringify({ ...readMeta(baseDir, key), cost }, null, 2) + "\n");
}
