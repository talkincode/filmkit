// CU estimate (PLAN §6.5). Pure: no I/O besides loading estimates.json.
//
//   CU = (startup + firstLoad + teardown + Σ(warm[variant]·scale + download)) / 3600 · rate · margin
//   scale = (w·h·frames / ref w·h·frames) ^ scaleExponent

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ColabComfyError, EXIT, invalid } from "./errors.ts";

export interface Estimates {
  startupSec: number;
  firstLoadSec: number;
  teardownSec: number;
  downloadSecPerJob: number;
  warmSecAtRef: Record<string, number>;
  reference: { width: number; height: number; frames: number };
  scaleExponent: number;
  rateCuPerHour: Record<string, number>;
  margin: number;
}

export const ESTIMATES_PATH = join(import.meta.dir, "..", "estimates.json");

export function loadEstimates(path: string = ESTIMATES_PATH): Estimates {
  return JSON.parse(readFileSync(path, "utf8")) as Estimates;
}

export interface EstimateJob {
  node: string;
  candidate: number;
  /** `dense` | `vsa-0.75` | `vsa-0.5` (job.variantKey) */
  variant: string;
  width: number;
  height: number;
  frames: number;
}

export interface JobEstimate extends EstimateJob {
  scale: number;
  genSec: number;
  downloadSec: number;
}

export interface Breakdown {
  gpu: string;
  rateCuPerHour: number;
  rateSource: "estimates.json" | "--rate";
  margin: number;
  fixedSec: { startup: number; firstLoad: number; teardown: number };
  jobs: JobEstimate[];
  totalSec: number;
  cu: number;
}

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

export function estimateCU(jobs: EstimateJob[], cfg: Estimates, opts: { gpu: string; rate?: number }): Breakdown {
  const rate = opts.rate ?? cfg.rateCuPerHour[opts.gpu];
  if (rate === undefined || !(rate > 0)) {
    throw new ColabComfyError(EXIT.invalidInput, [
      invalid(`no CU rate known for GPU "${opts.gpu}"`, "gpu", "pass --rate <CU per hour> (and --yes) to spend on a GPU other than L4"),
    ]);
  }
  const ref = cfg.reference.width * cfg.reference.height * cfg.reference.frames;
  const detail: JobEstimate[] = jobs.map((j) => {
    const warm = cfg.warmSecAtRef[j.variant];
    if (warm === undefined) {
      throw new ColabComfyError(EXIT.invalidInput, [invalid(`no warm-time calibration for variant "${j.variant}"`, "sparsity")]);
    }
    const scale = (j.width * j.height * j.frames) / ref;
    return { ...j, scale: round(scale, 4), genSec: round(warm * scale ** cfg.scaleExponent, 1), downloadSec: cfg.downloadSecPerJob };
  });
  // No jobs, no session, no cost.
  const fixed = jobs.length === 0 ? { startup: 0, firstLoad: 0, teardown: 0 } : { startup: cfg.startupSec, firstLoad: cfg.firstLoadSec, teardown: cfg.teardownSec };
  const totalSec = fixed.startup + fixed.firstLoad + fixed.teardown + detail.reduce((s, j) => s + j.genSec + j.downloadSec, 0);
  return {
    gpu: opts.gpu,
    rateCuPerHour: rate,
    rateSource: opts.rate === undefined ? "estimates.json" : "--rate",
    margin: cfg.margin,
    fixedSec: fixed,
    jobs: detail,
    totalSec: round(totalSec, 1),
    cu: round((totalSec / 3600) * rate * cfg.margin, 4),
  };
}
