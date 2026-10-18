// Run record (`produces.file`, PLAN §5.6; schema: schema/run-record.schema.json).
//
// Determinism contract (AGENTS: same inputs -> same bytes; filmkit pins this file's sha256 in the lock):
//   * every value comes from the node's params, the template, or the cache meta.json of a candidate;
//   * nothing is read from the clock, the environment, the GPU of *this* machine, or the cwd;
//   * serialization is canonicalJsonPretty (sorted keys, 2-space indent, trailing newline).
// Re-materializing the same node over the same cache therefore yields byte-identical output.

import { relative } from "node:path";
import { cachePaths, jobKeyInfo, readMeta, type CacheMeta } from "./cache.ts";
import { canonicalJsonPretty } from "./canonical.ts";
import { jobFrames, resolveRefs, type Job } from "./job.ts";
import type { Template } from "./workflow.ts";

export const RECORD_SCHEMA = "colab-comfy/run-record@1";
export const ATTRIBUTION = "session CU × this candidate's gen seconds / all gen seconds";

export interface CandidateEntry {
  index: number;
  seed: number;
  cacheKey: string;
  workflowSha256: string;
  video: { sha256: string; bytes: number };
  /** Relative to the film directory, so the record does not embed where the project lives. */
  cachePath: string;
  session: string;
  wallSec: number | null;
  peakVramMiB: number | null;
}

export interface RecordInput {
  baseDir: string;
  job: Job;
  tpl: Template;
  /** Index of the candidate that is copied to `produces.video`. */
  winner: number;
}

/** Cache state of every candidate index of a job: key + workflow hash, and the meta when it is cached. */
export function candidateStates(baseDir: string, job: Job, tpl: Template): { index: number; key: string; workflowSha256: string; meta: CacheMeta | null }[] {
  const refs = resolveRefs(job, baseDir);
  return Array.from({ length: job.candidates }, (_, index) => {
    const { key, workflowSha256 } = jobKeyInfo(tpl, job, index, refs);
    let meta: CacheMeta | null = null;
    try {
      meta = readMeta(baseDir, key);
    } catch {
      meta = null; // not cached (the winner's meta is re-read strictly in buildRecord)
    }
    return { index, key, workflowSha256, meta };
  });
}

/**
 * Throws when the winner is not cached. Other candidates are listed when they are cached (a pick can skip
 * generating the others); that list depends only on the cache, never on time.
 */
export function buildRecord(input: RecordInput): string {
  const { baseDir, job, tpl, winner } = input;
  const refs = resolveRefs(job, baseDir);
  const states = candidateStates(baseDir, job, tpl);
  const win = states[winner];
  if (!win) throw new Error(`winner index ${winner} is outside 0..${job.candidates - 1}`);
  const winMeta = readMeta(baseDir, win.key); // strict: a missing/corrupt winner must fail, not yield a thin record
  const winInfo = jobKeyInfo(tpl, job, winner, refs);

  const candidates: CandidateEntry[] = [];
  for (const s of states) {
    if (!s.meta) continue;
    candidates.push({
      index: s.index,
      seed: job.seed + s.index,
      cacheKey: s.key,
      workflowSha256: s.workflowSha256,
      video: { sha256: s.meta.video.sha256, bytes: s.meta.video.bytes },
      cachePath: relative(baseDir, cachePaths(baseDir, s.key).clip),
      session: s.meta.session,
      wallSec: s.meta.job.wallSec ?? null,
      peakVramMiB: s.meta.job.peakVramMiB ?? null,
    });
  }

  const env = winMeta.env ?? {};
  const cost = winMeta.cost;
  const record = {
    schema: RECORD_SCHEMA,
    node: job.node ?? null,
    template: { name: tpl.name, variant: winInfo.variant, fileSha256: winInfo.templateFileSha256, bindingsSha256: tpl.bindingsSha256 },
    params: {
      prompt: job.prompt,
      seed: job.seed,
      duration: job.duration,
      frames: jobFrames(job, tpl),
      fps: tpl.bindings.fps,
      width: job.width,
      height: job.height,
      sparsity: job.sparsity,
      candidates: job.candidates,
      pick: job.pick ?? null,
      refs: refs.map((r) => ({ path: r.path, sha256: r.sha256 })),
    },
    winner: {
      index: winner,
      seed: job.seed + winner,
      cacheKey: win.key,
      workflowSha256: win.workflowSha256,
      video: { sha256: winMeta.video.sha256, bytes: winMeta.video.bytes },
      selectedBy: job.candidates === 1 ? "single" : "params.pick",
    },
    candidates,
    models: {
      manifest: tpl.manifest.template,
      manifestSha256: tpl.manifestSha256,
      comfyui: { repo: env.comfyui?.repo ?? null, commit: env.comfyui?.commit ?? null },
      customNodes: (env.customNodes ?? []).map((n) => ({ repo: n.repo ?? null, commit: n.commit ?? null })),
      weights: (env.weights ?? []).map((w) => ({ repo: w.repo ?? null, file: w.file ?? null, revision: w.revision ?? null, sha256: w.sha256 ?? null, bytes: w.bytes ?? null })),
      python: env.python ?? null,
      torch: env.torch ?? null,
      cuda: env.cuda ?? null,
      comfyKitchen: env.comfyKitchen ?? null,
    },
    runtime: { provider: "colab", gpu: { name: env.gpu?.name ?? null, driver: env.gpu?.driver ?? null, memoryMiB: env.gpu?.memoryMiB ?? null } },
    cost: {
      session: cost?.session ?? winMeta.session,
      estimateCU: cost?.estimateCU ?? null,
      usageBeforeCU: cost?.usageBeforeCU ?? null,
      usageAfterCU: cost?.usageAfterCU ?? null,
      sessionActualCU: cost?.sessionActualCU ?? null,
      attributedCU: cost?.attributedCU ?? null,
      attribution: ATTRIBUTION,
    },
    stop: { stopped: cost?.stopped ?? null, sessionsVerifiedEmpty: cost?.sessionsVerifiedEmpty ?? null },
  };
  return canonicalJsonPretty(record);
}
