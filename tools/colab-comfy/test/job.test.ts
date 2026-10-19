import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ColabComfyError } from "../src/errors.ts";
import { MAX_DURATION, RESOLUTIONS, jobFrames, normalizeJob, sniffImage, validateJob, variantKey } from "../src/job.ts";
import { framesFor } from "../src/workflow.ts";
import { fakePng, makeJob, tmpProject, tpl } from "./support.ts";

const LENGTH = { min: 5, max: 3600, step: 17 };

describe("framesFor: smallest 5+17k >= ceil(round(d*24, 6))", () => {
  // [duration, frames]; the first five are the shots in context/ep03/h3-job/shots.json
  const table: [number, number][] = [
    [4.05, 107],
    [5.28, 141],
    [5.0, 124],
    [3.5, 90], // 84 -> 90
    [6.58, 158], // 157.92 -> 158 exactly on the grid
    [6.6, 175], // 158.4 -> 159 -> next grid point
    [0.05, 5], // below the minimum
    [0.2, 5], // 4.8 -> 5
    [0.25, 22], // 6 -> 22
    [1, 39], // 24 -> 39
  ];
  for (const [d, f] of table) {
    test(`${d}s -> ${f}`, () => expect(framesFor(d, 24, LENGTH)).toBe(f));
  }

  test("every result is on the 5+17k grid and covers the duration", () => {
    for (let d = 0.04; d < 6.7; d += 0.037) {
      const f = framesFor(d, 24, LENGTH);
      expect((f - 5) % 17).toBe(0);
      expect(f).toBeGreaterThanOrEqual(Math.ceil(Math.round(d * 24 * 1e6) / 1e6));
      expect(f - 17).toBeLessThan(Math.max(Math.ceil(d * 24 - 1e-6), 5));
    }
  });

  test("float noise cannot flip the ceil (4.05*24 = 97.19999999999999)", () => {
    expect(4.05 * 24).not.toBe(97.2);
    expect(jobFrames(makeJob({ duration: 4.05 }), tpl)).toBe(107);
  });
});

describe("normalizeJob", () => {
  test("accepts CLI strings and plan numbers alike", () => {
    const fromStrings = normalizeJob({
      node: "s1a", template: "h3-ref2va@1", prompt: "p", ref: "./a.png", seed: "20261017", duration: "4.05",
      resolution: "704x1280", sparsity: "0.75", candidates: "2", pick: "1",
    });
    const fromTyped = makeJob({ prompt: "p", ref: "./a.png", sparsity: 0.75, candidates: 2, pick: 1 });
    expect(fromStrings).toEqual(fromTyped);
    expect(fromTyped.width).toBe(704);
    expect(fromTyped.height).toBe(1280);
  });

  test("3:4 and 4:3 sizes parse to width x height", () => {
    expect(makeJob({ resolution: "768x1024" })).toMatchObject({ resolution: "768x1024", width: 768, height: 1024 });
    expect(makeJob({ resolution: "1024x768" })).toMatchObject({ resolution: "1024x768", width: 1024, height: 768 });
  });

  test("RESOLUTIONS is exactly the Profile's resolution enum (one list, two places)", () => {
    const profile = parseYaml(readFileSync(join(import.meta.dir, "..", "..", "..", "profiles", "colab-comfy.yaml"), "utf8"));
    expect(profile.tasks["h3-ref2va"].paramsSchema.properties.resolution.enum).toEqual([...RESOLUTIONS]);
  });

  test("defaults: sparsity 0, candidates 1, no pick", () => {
    const j = makeJob();
    expect([j.sparsity, j.candidates, j.pick]).toEqual([0, 1, undefined]);
    expect(variantKey(j)).toBe("dense");
    expect(variantKey(makeJob({ sparsity: 0.5 }))).toBe("vsa-0.5");
  });

  const bad: [string, Record<string, unknown>][] = [
    ["seed not an integer", { seed: "1.5" }],
    ["seed negative", { seed: -1 }],
    ["seed above 2^53-1", { seed: Number.MAX_SAFE_INTEGER + 2 }],
    ["duration zero", { duration: 0 }],
    ["duration above 6.6", { duration: 6.7 }],
    ["duration junk", { duration: "abc" }],
    ["resolution off the enum", { resolution: "640x360" }],
    ["sparsity off the enum", { sparsity: 0.6 }],
    ["candidates 0", { candidates: 0 }],
    ["candidates 5", { candidates: 5 }],
    ["pick negative", { pick: -1 }],
    ["ref3 without ref2", { ref3: "./c.png" }],
    ["prompt missing", { prompt: undefined }],
    ["template missing", { template: undefined }],
  ];
  for (const [name, over] of bad) {
    test(`rejects ${name} with exit 2`, () => {
      try {
        makeJob(over);
        throw new Error("expected a ColabComfyError");
      } catch (err) {
        expect(err).toBeInstanceOf(ColabComfyError);
        expect((err as ColabComfyError).exitCode).toBe(2);
        expect((err as ColabComfyError).details.every((d) => d.field)).toBe(true);
      }
    });
  }
});

describe("sniffImage", () => {
  test("PNG, JPEG, WebP by magic bytes; others undefined", () => {
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBP"))).toBe("webp");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeUndefined();
    expect(sniffImage(Buffer.from("GIF89a......"))).toBeUndefined();
  });
});

describe("validateJob (offline)", () => {
  let dir: string;
  let cleanup: () => void;
  beforeAll(() => {
    const p = tmpProject();
    ({ dir, cleanup } = p);
    p.write("refs/a.png", fakePng("a"));
    p.write("refs/b.png", fakePng("b"));
    p.write("refs/notes.txt", "hello");
  });
  afterAll(() => cleanup());
  const check = (over: Record<string, unknown> = {}, ctx: { out?: string; record?: string } = {}) =>
    validateJob(makeJob(over), { baseDir: dir, tpl, ...ctx });

  test("a good job has no problems", () => expect(check({}, { out: "./o.mp4", record: "./o.json" })).toEqual([]));
  test("missing pick is NOT an error even with candidates > 1", () => expect(check({ candidates: 3 })).toEqual([]));
  test("pick must be < candidates", () => expect(check({ candidates: 2, pick: 2 }).map((d) => d.field)).toEqual(["pick"]));
  test("missing ref file", () => expect(check({ ref: "./refs/nope.png" })[0]).toMatchObject({ field: "ref" }));
  test("ref that is not an image", () => expect(check({ ref: "./refs/notes.txt" })[0]?.message).toContain("magic bytes"));
  test("<Picture k> beyond the number of refs", () => {
    expect(check({ prompt: "<Picture 1> and <Picture 2>" })[0]).toMatchObject({ field: "prompt" });
    expect(check({ prompt: "<Picture 1> and <Picture 2>", ref2: "./refs/b.png" })).toEqual([]);
    expect(check({ prompt: "<Picture 0>" })[0]).toMatchObject({ field: "prompt" });
  });
  test("pixel*frame cap (1344x768 at 6s needs 158 frames)", () => {
    expect(check({ resolution: "1344x768", duration: 6 })[0]).toMatchObject({ field: "resolution" });
    expect(check({ resolution: "1344x768", duration: 5 })).toEqual([]); // 124 frames, the proven shape
    expect(check({ resolution: "704x1280", duration: 6.58 })).toEqual([]); // exactly the cap
  });
  test("3:4 / 4:3 fit the cap at every allowed duration (768x1024x175 = 137.6M < 142.4M)", () => {
    for (const resolution of ["768x1024", "1024x768"]) {
      expect(check({ resolution, duration: MAX_DURATION })).toEqual([]);
      expect(jobFrames(makeJob({ resolution, duration: MAX_DURATION }), tpl)).toBe(175);
    }
  });
  test("--out / --record extensions", () => {
    expect(check({}, { out: "./o.mov", record: "./o.json" }).map((d) => d.field)).toEqual(["out"]);
    expect(check({}, { out: "./o.mp4", record: "./o.yaml" }).map((d) => d.field)).toEqual(["record"]);
  });
});
