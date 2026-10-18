import { describe, expect, test } from "bun:test";
import { ColabComfyError } from "../src/errors.ts";
import { estimateCU, loadEstimates, type EstimateJob } from "../src/estimate.ts";

const cfg = loadEstimates();
const job = (node: string, variant: string, frames: number, width = 704, height = 1280): EstimateJob => ({ node, candidate: 0, variant, width, height, frames });

// EP03 test film (PLAN §6.5): 704x1280; s1a dense 107f, s3a vsa-0.75 141f, s4a vsa-0.5 141f
const EP03 = [job("s1a", "dense", 107), job("s3a", "vsa-0.75", 141), job("s4a", "vsa-0.5", 141)];

describe("estimateCU", () => {
  test("EP03 example ~ 0.77 CU (+-0.01) and ~1353 s", () => {
    const e = estimateCU(EP03, cfg, { gpu: "L4" });
    expect(e.cu).toBeGreaterThan(0.76);
    expect(e.cu).toBeLessThan(0.78);
    expect(Math.abs(e.totalSec - 1353)).toBeLessThan(3);
    expect(e.fixedSec).toEqual({ startup: 480, firstLoad: 120, teardown: 120 });
    expect(e.jobs.map((j) => Math.round(j.genSec))).toEqual([196, 189, 218]);
    expect(e.rateSource).toBe("estimates.json");
  });

  test("the reference shape (1344x768x124) costs exactly its calibrated warm time", () => {
    const e = estimateCU([job("a2", "dense", 124, 1344, 768)], cfg, { gpu: "L4" });
    expect(e.jobs[0]).toMatchObject({ scale: 1, genSec: 260 });
    expect(e.totalSec).toBe(480 + 120 + 120 + 260 + 10);
  });

  test("a single dense EP03 job is the ~0.54 CU a `filmkit run` spend costs", () => {
    const e = estimateCU([EP03[0]!], cfg, { gpu: "L4" });
    expect(e.cu).toBeGreaterThan(0.5);
    expect(e.cu).toBeLessThan(0.58);
  });

  test("zero jobs cost nothing (no session)", () => {
    const e = estimateCU([], cfg, { gpu: "L4" });
    expect([e.cu, e.totalSec]).toEqual([0, 0]);
  });

  test("--rate overrides the table and is reported", () => {
    const base = estimateCU(EP03, cfg, { gpu: "L4" });
    const dbl = estimateCU(EP03, cfg, { gpu: "L4", rate: 3.4 });
    expect(dbl.rateSource).toBe("--rate");
    expect(dbl.cu).toBeCloseTo(base.cu * 2, 3);
  });

  test("an unknown GPU without --rate is invalid input; with --rate it works", () => {
    try {
      estimateCU(EP03, cfg, { gpu: "A100" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ColabComfyError);
      expect((err as ColabComfyError).exitCode).toBe(2);
    }
    expect(estimateCU(EP03, cfg, { gpu: "A100", rate: 5 }).cu).toBeGreaterThan(0);
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
