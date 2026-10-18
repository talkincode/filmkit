import { describe, expect, test } from "bun:test";
import { ColabComfyError } from "../src/errors.ts";
import { chooseGpu, estimateCU, isCalibrated, loadEstimates, type EstimateJob } from "../src/estimate.ts";

const cfg = loadEstimates();
const job = (node: string, variant: string, frames: number, width = 704, height = 1280): EstimateJob => ({ node, candidate: 0, variant, width, height, frames });

// EP03 test film (PLAN §6.5): 704x1280; s1a dense 107f, s3a vsa-0.75 141f, s4a vsa-0.5 141f
const EP03 = [job("s1a", "dense", 107), job("s3a", "vsa-0.75", 141), job("s4a", "vsa-0.5", 141)];

describe("estimateCU", () => {
  // Calibration (M8 real L4 run, 2026-10-17): per-clip wall s1a 318 s / s3a 354 s / s4a(124f) 340 s,
  // startup (setup + ComfyUI start) ~220 s; session 0.51 CU settled. The estimate keeps the 1.2 margin on top.
  test("EP03 example on L4 ~ 0.76 CU and ~1333 s; per-clip times match the M8 run", () => {
    const e = estimateCU(EP03, cfg, { gpu: "L4" });
    expect(e.cu).toBeGreaterThan(0.75);
    expect(e.cu).toBeLessThan(0.77);
    expect(Math.abs(e.totalSec - 1333)).toBeLessThan(3);
    expect(e.fixedSec).toEqual({ startup: 225, firstLoad: 0, teardown: 30 });
    expect(e.jobs.map((j) => Math.round(j.genSec))).toEqual([318, 354, 376]);
    expect(Math.round(estimateCU([job("s4a", "vsa-0.5", 124)], cfg, { gpu: "L4" }).jobs[0]!.genSec)).toBe(340);
    expect(e.rateSource).toBe("estimates.json");
  });

  test("the reference shape (1344x768x124) costs exactly its calibrated warm time", () => {
    const e = estimateCU([job("a2", "dense", 124, 1344, 768)], cfg, { gpu: "L4" });
    expect(e.jobs[0]).toMatchObject({ scale: 1, initSec: 80, genSec: 80 + 316 });
    expect(e.totalSec).toBe(225 + 0 + 30 + 396 + 10);
  });

  test("a single dense EP03 job on L4 is ~0.33 CU", () => {
    const e = estimateCU([EP03[0]!], cfg, { gpu: "L4" });
    expect(e.cu).toBeGreaterThan(0.3);
    expect(e.cu).toBeLessThan(0.36);
  });

  // Calibration (A100 benchmark, 2026-10-18): 5.30 CU/h, setup+start ~200 s, s1a first 104 s, warm 56 s,
  // session 0.60 CU settled for two clips. The old table (L4 timings x 5.4 CU/h) said ~1.8 CU for one clip.
  test("A100: s1a first clip ~104 s, warm ~56 s; one clip ~0.63 CU (not the old ~3x)", () => {
    expect(isCalibrated(cfg, "A100")).toBe(true);
    const one = estimateCU([EP03[0]!], cfg, { gpu: "A100" });
    expect(one.rateCuPerHour).toBe(5.3);
    expect(one.timingGpu).toBe("A100");
    expect(Math.round(one.fixedSec.firstLoad + one.jobs[0]!.genSec)).toBe(104);
    expect(Math.round(one.jobs[0]!.genSec)).toBe(56);
    expect(one.cu).toBeGreaterThan(0.6);
    expect(one.cu).toBeLessThan(0.68);
    const two = estimateCU([EP03[0]!, job("s1b", "dense", 107)], cfg, { gpu: "A100" });
    // the measured 0.60 CU session (two s1a renders): the un-margined model is within 10%, the margin is on top
    expect(Math.abs(two.cu / cfg.margin - 0.6) / 0.6).toBeLessThan(0.1);
    expect(two.cu).toBeGreaterThan(0.6 * 1.1);
  });

  test("zero jobs cost nothing (no session)", () => {
    const e = estimateCU([], cfg, { gpu: "L4" });
    expect([e.cu, e.totalSec]).toEqual([0, 0]);
  });

  test("--rate overrides the table and is reported", () => {
    const base = estimateCU(EP03, cfg, { gpu: "L4" });
    const dbl = estimateCU(EP03, cfg, { gpu: "L4", rate: 3.42 });
    expect(dbl.rateSource).toBe("--rate");
    expect(dbl.cu).toBeCloseTo(base.cu * 2, 3);
  });

  test("an uncalibrated GPU without --rate is invalid input; with --rate it works on L4 timings", () => {
    expect(isCalibrated(cfg, "T4")).toBe(false);
    try {
      estimateCU(EP03, cfg, { gpu: "T4" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ColabComfyError);
      expect((err as ColabComfyError).exitCode).toBe(2);
    }
    const t4 = estimateCU(EP03, cfg, { gpu: "T4", rate: 1.2 });
    expect(t4.timingGpu).toBe("L4");
    expect(t4.totalSec).toBe(estimateCU(EP03, cfg, { gpu: "L4" }).totalSec);
  });

  test("a variant without calibration is refused rather than guessed", () => {
    expect(() => estimateCU([job("x", "vsa-0.25", 107)], cfg, { gpu: "L4" })).toThrow(ColabComfyError);
  });

  test("monotonic: more jobs, more frames, more CU", () => {
    const one = estimateCU([EP03[0]!], cfg, { gpu: "L4" }).cu;
    expect(estimateCU(EP03.slice(0, 2), cfg, { gpu: "L4" }).cu).toBeGreaterThan(one);
    expect(estimateCU([job("s", "dense", 158)], cfg, { gpu: "L4" }).cu).toBeGreaterThan(estimateCU([job("s", "dense", 107)], cfg, { gpu: "L4" }).cu);
  });
});

describe("chooseGpu (--gpu auto)", () => {
  const dense = (n: number) => Array.from({ length: n }, (_, i) => job(`s${i}`, "dense", 107));
  test("auto candidates are only L4 and A100", () => {
    expect(cfg.autoGpus).toEqual(["L4", "A100"]);
    expect(chooseGpu(dense(1), cfg, 99).candidates.map((c) => c.gpu)).toEqual(["L4", "A100"]);
  });

  test("few clips -> L4 (cheaper: A100's higher rate dominates the fixed cost)", () => {
    for (const n of [1, 3, 5]) {
      const c = chooseGpu(dense(n), cfg, 99);
      expect(c.gpu).toBe("L4");
      expect(c.estimate.gpu).toBe("L4");
      expect(c.fallback).toBeNull(); // an L4 pick never escalates to A100
    }
  });

  test("many clips -> A100 (break-even ~5-6 dense EP03 clips); fallback L4 only if it fits the budget", () => {
    const c = chooseGpu(dense(8), cfg, 99);
    expect(c.gpu).toBe("A100");
    const [l4, a100] = c.candidates;
    expect(a100!.cu).toBeLessThan(l4!.cu);
    expect(c.fallback?.gpu).toBe("L4");
    expect(chooseGpu(dense(8), cfg, a100!.cu).fallback).toBeNull(); // L4 would exceed the budget
  });

  test("the pick is the minimum estimated CU", () => {
    for (let n = 1; n <= 12; n++) {
      const c = chooseGpu(dense(n), cfg, 99);
      expect(c.estimate.cu).toBe(Math.min(...c.candidates.map((x) => x.cu)));
    }
  });
});
