import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ColabComfyError } from "../src/errors.ts";
import { MAX_DURATION, RESOLUTIONS, jobFrames, normalizeJob, resolveInputs, sniffImage, validateJob, variantKey, wavDurationSec } from "../src/job.ts";
import { framesFor, TEMPLATE_NAMES } from "../src/workflow.ts";
import { fakePng, fakeWav, makeJob, tmpProject, tpl, tpl2 } from "./support.ts";

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

  test("RESOLUTIONS / TEMPLATE_NAMES are exactly the Profile's enums (one list, two places)", () => {
    const profile = parseYaml(readFileSync(join(import.meta.dir, "..", "..", "..", "profiles", "colab-comfy.yaml"), "utf8"));
    const tasks = ["h3-ref2va", "h3-fl2va"].map((t) => profile.tasks[t].paramsSchema.properties);
    for (const props of tasks) expect(props.resolution.enum).toEqual([...RESOLUTIONS]);
    expect(Object.keys(profile.tasks).sort()).toEqual(["h3-fl2va", "h3-ref2va"]);
    expect(tasks.flatMap((props) => props.template.enum)).toEqual([...TEMPLATE_NAMES]);
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

describe("wavDurationSec (header only)", () => {
  test("PCM mono 24 kHz / stereo 48 kHz: data bytes / byte rate", () => {
    expect(wavDurationSec(fakeWav(3.56))).toBeCloseTo(3.56, 6);
    expect(wavDurationSec(fakeWav(1.04, "", 48000, 2))).toBeCloseTo(1.04, 6);
  });
  test("skips extra chunks before data (LIST etc.)", () => {
    const w = fakeWav(2);
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
    const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)]);
    expect(wavDurationSec(withList)).toBeCloseTo(2, 6);
  });
  test("not a WAV / no data chunk -> undefined", () => {
    expect(wavDurationSec(fakePng("x"))).toBeUndefined();
    expect(wavDurationSec(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeUndefined();
    expect(wavDurationSec(fakeWav(1).subarray(0, 36))).toBeUndefined();
  });
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
    p.write("vo/s1a.wav", fakeWav(3.56, "vo"));
    p.write("vo/exact.wav", fakeWav(107 / 24, "exact"));
    p.write("vo/long.wav", fakeWav(4.6, "long"));
    p.write("vo/empty.wav", fakeWav(0));
  });
  afterAll(() => cleanup());
  const check = (over: Record<string, unknown> = {}, ctx: { out?: string; record?: string } = {}) =>
    validateJob(makeJob(over), { baseDir: dir, tpl, ...ctx });
  /** Same, on h3-ref2va@2 (the template with the audio guide). */
  const check2 = (over: Record<string, unknown> = {}) => validateJob(makeJob({ template: "h3-ref2va@2", ...over }), { baseDir: dir, tpl: tpl2 });

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
  test("audio guide: a WAV no longer than the clip is fine (107 f = 4.458 s at 4.05 s duration)", () => {
    expect(check2({ audio: "./vo/s1a.wav" })).toEqual([]);
    expect(check2({ audio: "./vo/exact.wav" })).toEqual([]);
    expect(check2()).toEqual([]);
    expect(makeJob({ audio: "./vo/s1a.wav" }).audio).toBe("./vo/s1a.wav");
    expect(makeJob().audio).toBeUndefined();
  });
  test("audio guide failures carry field audio", () => {
    // @1 is frozen without the guide: refused with a pointer to @2, not silently ignored
    expect(check({ audio: "./vo/s1a.wav" })[0]).toMatchObject({ field: "audio", hint: expect.stringContaining("h3-ref2va@2") });
    expect(check2({ audio: "./vo/nope.wav" })[0]).toMatchObject({ field: "audio", message: expect.stringContaining("not found") });
    expect(check2({ audio: "./refs/notes.txt" })[0]).toMatchObject({ field: "audio", message: expect.stringContaining("RIFF/WAVE") });
    expect(check2({ audio: "./vo/empty.wav" })[0]).toMatchObject({ field: "audio" });
    const long = check2({ audio: "./vo/long.wav" });
    expect(long[0]).toMatchObject({ field: "audio", message: expect.stringContaining("would be cropped") });
    expect(check2({ audio: "./vo/long.wav", duration: 4.6 })).toEqual([]); // 4.6 s -> 124 f = 5.167 s covers it
  });
  test("resolveInputs hashes the audio and reads its duration", () => {
    const inputs = resolveInputs(makeJob({ audio: "./vo/s1a.wav" }), dir);
    expect(inputs.audio).toMatchObject({ path: "./vo/s1a.wav", ext: "wav" });
    expect(inputs.audio!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs.audio!.durationSec).toBeCloseTo(3.56, 6);
    expect(resolveInputs(makeJob(), dir).audio).toBeUndefined();
    expect(() => resolveInputs(makeJob({ audio: "./vo/nope.wav" }), dir)).toThrow(ColabComfyError);
  });
  test("--out / --record extensions", () => {
    expect(check({}, { out: "./o.mov", record: "./o.json" }).map((d) => d.field)).toEqual(["out"]);
    expect(check({}, { out: "./o.mp4", record: "./o.yaml" }).map((d) => d.field)).toEqual(["record"]);
  });
});
