// CU estimate (PLAN §6.5, recalibrated from the M8 real runs). Pure: no I/O besides loading estimates.json.
//
//   CU = (startup + firstLoad + teardown + Σ(perJobInit + warm[variant]·scale + download)) / 3600 · rate · margin
//   scale = (w·h·frames / ref w·h·frames) ^ scaleExponent
//
// Every coefficient is per GPU (`gpus.<GPU>` in estimates.json). Calibration (M8, 704x1280, README §Real run):
//   startup     `colab new` -> first prompt submitted (pip + 48 GB weights + ComfyUI start): L4 225 s, A100 215 s
//   perJobInit  model re-initialisation that every job pays (new prompt / VSA patch): L4 ~80 s, A100 ~10 s
//   firstLoad   extra on the first job only: A100 104 s first vs 56 s warm -> 48 s; on L4 it is inside the 80 s init
//   warm        the frame-proportional rest, per variant. L4: s1a 318 s, s3a 354 s, s4a 340 s reproduce exactly.
//               A100 VSA values are derived from the L4 VSA/dense ratios (only dense was measured on A100).
//   teardown    last download + log collection + stop (measured ~15 s; 30 s kept)
//   rate        nominal `colab usage` rate: L4 1.71, A100 5.30 CU/h. The safety margin (1.2) stays on top.
//   audioGuide  a h3-ref2va@2 job with the optional audio guide multiplies its warm time by audioGuide.warmFactor
//               (1.03; A100 measured +2.5% on EP004, see estimates.json `basis`).
//   fl2va-8step h3-fl2va@1 (fl2va + turbo 8-step LoRA, guide built in) has its own warm key. L4 is fitted to the
//               EP03 / 李律 EP01 runs (704x1280, 90-158 f); A100 is derived (`uncalibrated`), see estimates.json.
// A GPU without its own entry (T4, G4, H100, ...) uses the L4 timings with an explicit --rate (and needs --yes).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ColabComfyError, EXIT, invalid } from "./errors.ts";

export interface GpuEstimates {
  rateCuPerHour: number;
  startupSec: number;
  firstLoadSec: number;
  teardownSec: number;
  perJobInitSec: number;
  warmSecAtRef: Record<string, number>;
}

export interface Estimates {
  reference: { width: number; height: number; frames: number };
  scaleExponent: number;
  downloadSecPerJob: number;
  margin: number;
  /** GPUs `--gpu auto` may choose from (only L4 and A100: never H100, never high-mem). */
  autoGpus: string[];
  /** Extra warm time for a job with an audio guide (MiniMaxH3AddGuide); `calibrated: false` until measured. */
  audioGuide?: { warmFactor: number; calibrated: boolean; basis?: string };
  gpus: Record<string, GpuEstimates>;
  /** Warm keys whose timings on a GPU are derived rather than measured: gpu -> key -> basis. */
  uncalibrated?: Record<string, Record<string, string>>;
  /** Free-form provenance per warm key (not used in the arithmetic). */
  basis?: Record<string, string>;
}

/** The GPU whose timings stand in for an uncalibrated GPU. */
export const BASE_TIMING_GPU = "L4";

export const ESTIMATES_PATH = join(import.meta.dir, "..", "estimates.json");

export function loadEstimates(path: string = ESTIMATES_PATH): Estimates {
  return JSON.parse(readFileSync(path, "utf8")) as Estimates;
}

/** The GPU has its own calibrated timings and rate in estimates.json. */
export function isCalibrated(cfg: Estimates, gpu: string): boolean {
  return cfg.gpus[gpu] !== undefined;
}

export interface EstimateJob {
  node: string;
  candidate: number;
  /** `dense` | `vsa-0.75` | `vsa-0.5` (job.variantKey) */
  variant: string;
  width: number;
  height: number;
  frames: number;
  /** The job feeds an audio guide (lip sync) into MiniMaxH3AddGuide. */
  audioGuide?: boolean;
}

export interface JobEstimate extends EstimateJob {
  scale: number;
  /** Warm-time multiplier applied for the audio guide (estimates.json audioGuide.warmFactor); absent without audio. */
  audioGuideFactor?: number;
  audioGuideCalibrated?: boolean;
  /** false when this warm key's timing on the timing GPU is derived, not measured (estimates.json `uncalibrated`). */
  calibrated: boolean;
  basis?: string;
  /** perJobInit + warm·scale */
  genSec: number;
  initSec: number;
  downloadSec: number;
}

export interface Breakdown {
  gpu: string;
  rateCuPerHour: number;
  rateSource: "estimates.json" | "--rate";
  /** Whose timings were used (the GPU itself, or L4 for an uncalibrated GPU). */
  timingGpu: string;
  margin: number;
  fixedSec: { startup: number; firstLoad: number; teardown: number };
  jobs: JobEstimate[];
  totalSec: number;
  cu: number;
}

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

export function estimateCU(jobs: EstimateJob[], cfg: Estimates, opts: { gpu: string; rate?: number }): Breakdown {
  const own = cfg.gpus[opts.gpu];
  const rate = opts.rate ?? own?.rateCuPerHour;
  if (rate === undefined || !(rate > 0)) {
    throw new ColabComfyError(EXIT.invalidInput, [
      invalid(`no CU rate known for GPU "${opts.gpu}"`, "gpu", `pass --rate <CU per hour> (and --yes) to spend on a GPU without calibration (${Object.keys(cfg.gpus).join(", ")} are calibrated)`),
    ]);
  }
  const timingGpu = own ? opts.gpu : BASE_TIMING_GPU;
  const t = cfg.gpus[timingGpu]!;
  const ref = cfg.reference.width * cfg.reference.height * cfg.reference.frames;
  const detail: JobEstimate[] = jobs.map((j) => {
    const warm = t.warmSecAtRef[j.variant];
    if (warm === undefined) {
      throw new ColabComfyError(EXIT.invalidInput, [invalid(`no warm-time calibration for variant "${j.variant}"`, "sparsity")]);
    }
    const scale = (j.width * j.height * j.frames) / ref;
    const guide = j.audioGuide ? (cfg.audioGuide?.warmFactor ?? 1) : undefined;
    const unc = cfg.uncalibrated?.[timingGpu]?.[j.variant];
    return {
      ...j,
      scale: round(scale, 4),
      ...(guide !== undefined ? { audioGuideFactor: guide, audioGuideCalibrated: cfg.audioGuide?.calibrated ?? false } : {}),
      calibrated: unc === undefined,
      ...(unc !== undefined ? { basis: unc } : {}),
      initSec: t.perJobInitSec,
      genSec: round(t.perJobInitSec + warm * scale ** cfg.scaleExponent * (guide ?? 1), 1),
      downloadSec: cfg.downloadSecPerJob,
    };
  });
  // No jobs, no session, no cost.
  const fixed = jobs.length === 0 ? { startup: 0, firstLoad: 0, teardown: 0 } : { startup: t.startupSec, firstLoad: t.firstLoadSec, teardown: t.teardownSec };
  const totalSec = fixed.startup + fixed.firstLoad + fixed.teardown + detail.reduce((s, j) => s + j.genSec + j.downloadSec, 0);
  return {
    gpu: opts.gpu,
    rateCuPerHour: rate,
    rateSource: opts.rate === undefined ? "estimates.json" : "--rate",
    timingGpu,
    margin: cfg.margin,
    fixedSec: fixed,
    jobs: detail,
    totalSec: round(totalSec, 1),
    cu: cuFor(totalSec, rate, cfg.margin),
  };
}

/** CU for a wall time at a rate, margin included (also used to re-check with the rate `colab usage` reports). */
export function cuFor(totalSec: number, rateCuPerHour: number, margin: number): number {
  return round((totalSec / 3600) * rateCuPerHour * margin, 4);
}

export interface AutoChoice {
  /** The cheapest GPU by estimated CU (ties go to the earlier entry of autoGpus, i.e. L4). */
  gpu: string;
  estimate: Breakdown;
  candidates: { gpu: string; cu: number; totalSec: number }[];
  /** Used when `colab new` cannot get `gpu`: the cheapest other auto GPU whose estimate fits the budget. */
  fallback: Breakdown | null;
}

/** `--gpu auto`: pick the auto GPU with the lowest estimated CU for these jobs. */
export function chooseGpu(jobs: EstimateJob[], cfg: Estimates, budgetCU: number): AutoChoice {
  const ests = cfg.autoGpus.filter((g) => isCalibrated(cfg, g)).map((g) => estimateCU(jobs, cfg, { gpu: g }));
  if (ests.length === 0) throw new ColabComfyError(EXIT.invalidInput, [invalid("estimates.json lists no calibrated autoGpus", "gpu")]);
  let best = ests[0]!;
  for (const e of ests.slice(1)) if (e.cu < best.cu) best = e;
  // Only downward: an A100 pick may fall back to L4 (if L4 fits the budget too); an L4 pick never escalates
  // to a pricier GPU on its own.
  const base = ests.find((e) => e.gpu === BASE_TIMING_GPU);
  const fallback = best.gpu !== BASE_TIMING_GPU && base && base.cu <= budgetCU ? base : null;
  return { gpu: best.gpu, estimate: best, candidates: ests.map((e) => ({ gpu: e.gpu, cu: e.cu, totalSec: e.totalSec })), fallback };
}
