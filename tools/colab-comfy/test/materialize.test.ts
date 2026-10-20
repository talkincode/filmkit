// materialize + run record (PLAN §5.4, §5.6, §8.1 U*): offline, no `colab`, no network. The cache is seeded by hand
// with the exact layout session.ts writes; the real session path is covered by tests/colab-comfy.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectJobs, type PlanJson } from "../src/batch.ts";
import { cachePaths, jobCacheKey, jobKeyInfo, writeFileAtomic, type CacheMeta } from "../src/cache.ts";
import { canonicalJsonPretty, sha256Hex } from "../src/canonical.ts";
import { main } from "../src/cli.ts";
import { normalizeJob, resolveInputs, type Job } from "../src/job.ts";
import { buildRecord } from "../src/record.ts";
import { loadTemplate } from "../src/workflow.ts";
import { fakeColabEnv, readCalls } from "./fake-colab.ts";
import { fakePng, fakeWav, makeJob, tmpProject, tpl, tpl2 } from "./support.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const SCHEMA = JSON.parse(readFileSync(join(REPO, "tools/colab-comfy/schema/run-record.schema.json"), "utf8"));
const validateRecord = new Ajv2020({ allErrors: true, strict: true }).compile(SCHEMA);

let p: ReturnType<typeof tmpProject>;
beforeEach(() => {
  p = tmpProject();
  p.write("refs/a.png", fakePng("a"));
});
afterEach(() => p.cleanup());

const CLIP = Buffer.from("not really an mp4, but bytes are bytes");

/** Seed one cache entry the way session.ts + attachCost leave it. Returns the key. */
function seed(job: Job, index: number, over: Partial<CacheMeta> = {}, clip: Buffer = CLIP): string {
  const key = jobCacheKey(loadTemplate(job.template), job, index, resolveInputs(job, p.dir));
  const paths = cachePaths(p.dir, key);
  writeFileAtomic(paths.clip, clip);
  const meta: CacheMeta = {
    key,
    node: job.node ?? "s1a",
    candidate: index,
    seed: job.seed + index,
    session: "fk-unit-202601010000",
    downloadedAt: "2026-01-01T00:00:00.000Z",
    job: { key, state: "done", wallSec: 100 + index, peakVramMiB: 22000 + index },
    env: {
      gpu: { name: "NVIDIA L4", driver: "580.82.07", memoryMiB: 23034 },
      python: "3.12.1",
      torch: "2.11.0+cu130",
      cuda: "13.0",
      comfyKitchen: "0.2.38",
      comfyui: { repo: "https://github.com/Comfy-Org/ComfyUI", commit: "a".repeat(40) },
      customNodes: [{ repo: "https://github.com/Kablex/ComfyUI-Ref2VA-VSA", commit: "b".repeat(40) }],
      weights: [{ repo: "Comfy-Org/MiniMax-H3", file: "diffusion_models/x.safetensors", revision: "c".repeat(40), sha256: "d".repeat(64), bytes: 123 }],
    },
    video: { sha256: sha256Hex(clip), bytes: clip.length },
    cost: { session: "fk-unit-202601010000", estimateCU: 0.77, usageBeforeCU: 350.07, usageAfterCU: 349.19, sessionActualCU: 0.88, attributedCU: 0.22, stopped: true, sessionsVerifiedEmpty: true },
    ...over,
  };
  writeFileAtomic(paths.meta, JSON.stringify(meta, null, 2) + "\n");
  return key;
}

/** argv exactly as the Profile's `invocation` renders it. */
function argvFor(over: Record<string, unknown> = {}, out = "./build/s1a.mp4", record = "./build/s1a.colab.json"): string[] {
  const v = { node: "s1a", template: "h3-ref2va@1", prompt: "The woman from <Picture 1> talks.", ref: "./refs/a.png", seed: 20261017, duration: 4.05, resolution: "704x1280", sparsity: 0, ...over };
  const args = ["materialize"];
  for (const [k, val] of Object.entries(v)) if (val !== undefined) args.push(`--${k}=${val}`);
  return [...args, `--out=${out}`, `--record=${record}`];
}

const job = (over: Record<string, unknown> = {}): Job => makeJob({ prompt: "The woman from <Picture 1> talks.", ...over });
const run = (args: string[], env: Record<string, string | undefined> = {}) => main(args, env, p.dir);
const files = () => ({ out: existsSync(p.dir + "/build/s1a.mp4"), record: existsSync(p.dir + "/build/s1a.colab.json") });

describe("materialize: cache hit", () => {
  test("copies the clip, writes a schema-valid record; re-materializing is byte-identical", async () => {
    const key = seed(job(), 0);
    const r = await run(argvFor());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("candidate 0");
    expect(readFileSync(p.dir + "/build/s1a.mp4")).toEqual(CLIP);
    const text = readFileSync(p.dir + "/build/s1a.colab.json", "utf8");
    const rec = JSON.parse(text);
    expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
    expect(rec).toMatchObject({
      schema: "colab-comfy/run-record@1",
      node: "s1a",
      template: { name: "h3-ref2va@1", variant: "dense" },
      params: { seed: 20261017, frames: 107, fps: 24, width: 704, height: 1280, sparsity: 0, candidates: 1, pick: null, refs: [{ path: "./refs/a.png", sha256: sha256Hex(fakePng("a")) }] },
      winner: { index: 0, seed: 20261017, cacheKey: key, selectedBy: "single", video: { sha256: sha256Hex(CLIP), bytes: CLIP.length } },
      runtime: { provider: "colab", gpu: { name: "NVIDIA L4", driver: "580.82.07" } },
      models: { manifest: "h3-ref2va@1", comfyui: { commit: "a".repeat(40) }, torch: "2.11.0+cu130" },
      cost: { session: "fk-unit-202601010000", estimateCU: 0.77, usageBeforeCU: 350.07, usageAfterCU: 349.19, sessionActualCU: 0.88, attributedCU: 0.22 },
      stop: { stopped: true, sessionsVerifiedEmpty: true },
    });
    expect(rec.candidates).toHaveLength(1);
    expect(rec.candidates[0]).toMatchObject({ index: 0, cachePath: `.colab-comfy/cache/${key.slice(0, 2)}/${key}/clip.mp4`, wallSec: 100, peakVramMiB: 22000 });
    // no host-specific or time-dependent value
    expect(text).not.toContain(p.dir);
    expect(text).not.toContain("downloadedAt");

    const again = await run(argvFor());
    expect(again.exitCode).toBe(0);
    expect(readFileSync(p.dir + "/build/s1a.colab.json", "utf8")).toBe(text);
    expect(readFileSync(p.dir + "/build/s1a.mp4")).toEqual(CLIP);
    expect(readdirSync(p.dir + "/build").sort()).toEqual(["s1a.colab.json", "s1a.mp4"]); // no .part left
  });

  test("record determinism: same cache -> same bytes, also across different insertion order of meta keys", () => {
    seed(job(), 0);
    const a = buildRecord({ baseDir: p.dir, job: job(), tpl, winner: 0 });
    const b = buildRecord({ baseDir: p.dir, job: job(), tpl, winner: 0 });
    expect(a).toBe(b);
    expect(a).toBe(canonicalJsonPretty(JSON.parse(a))); // sorted keys, 2-space indent, trailing newline
    expect(a.endsWith("}\n")).toBe(true);
    // rewriting meta.json with shuffled key order must not change the record
    const key = jobCacheKey(tpl, job(), 0, resolveInputs(job(), p.dir));
    const meta = JSON.parse(readFileSync(cachePaths(p.dir, key).meta, "utf8"));
    const shuffled = Object.fromEntries(Object.entries(meta).reverse());
    writeFileAtomic(cachePaths(p.dir, key).meta, JSON.stringify(shuffled));
    expect(buildRecord({ baseDir: p.dir, job: job(), tpl, winner: 0 })).toBe(a);
  });

  test("a meta without cost info (older cache) still yields a valid record with nulls", async () => {
    seed(job(), 0, { cost: undefined });
    expect((await run(argvFor())).exitCode).toBe(0);
    const rec = JSON.parse(readFileSync(p.dir + "/build/s1a.colab.json", "utf8"));
    expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
    expect(rec.cost).toMatchObject({ estimateCU: null, sessionActualCU: null, attributedCU: null });
    expect(rec.stop).toEqual({ stopped: null, sessionsVerifiedEmpty: null });
  });

  test("an audio-guided job records the audio (path, sha256, duration) and the record stays schema-valid", async () => {
    p.write("vo/s1a.wav", fakeWav(3.56, "vo"));
    const guided = job({ template: "h3-ref2va@2", audio: "./vo/s1a.wav" });
    const key = seed(guided, 0);
    expect(key).not.toBe(jobCacheKey(tpl2, job({ template: "h3-ref2va@2" }), 0, resolveInputs(job(), p.dir)));
    expect((await run(argvFor({ template: "h3-ref2va@2", audio: "./vo/s1a.wav" }))).exitCode).toBe(0);
    const rec = JSON.parse(readFileSync(p.dir + "/build/s1a.colab.json", "utf8"));
    expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
    expect(rec.params.audio).toEqual({ path: "./vo/s1a.wav", sha256: sha256Hex(fakeWav(3.56, "vo")), durationSec: 3.56 });
    expect(rec.winner.cacheKey).toBe(key);
  });

  test("sparsity > 0 records the vsa variant", async () => {
    seed(job({ sparsity: 0.75 }), 0);
    expect((await run(argvFor({ sparsity: 0.75 }))).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(p.dir + "/build/s1a.colab.json", "utf8")).template.variant).toBe("vsa");
  });
});

describe("batch key == materialize key (PLAN §8.1 U*)", () => {
  test("plan JSON params (typed) and argv flags (strings) resolve to the same cache key", async () => {
    const params = { template: "h3-ref2va@1", prompt: "The woman from <Picture 1> talks.", ref: "./refs/a.png", seed: 20261017, duration: 4.05, resolution: "704x1280", sparsity: 0.75, candidates: 2 };
    const plan: PlanJson = { film: p.dir + "/filmkit.yaml", nodes: [{ id: "s1a", status: "missing", profile: { name: "colab-comfy" }, task: "h3-ref2va", params, inputs: {} }] };
    const batchKeys = collectJobs(plan, p.dir).selected[0]!.candidates.map((c) => c.key);

    const flags = { node: "s1a", template: "h3-ref2va@1", prompt: params.prompt, ref: "./refs/a.png", seed: "20261017", duration: "4.05", resolution: "704x1280", sparsity: "0.75", candidates: "2", pick: "1" };
    const j = normalizeJob(flags);
    const matKeys = [0, 1].map((i) => jobKeyInfo(tpl, j, i, resolveInputs(j, p.dir)).key);
    expect(matKeys).toEqual(batchKeys);

    // and end to end: a clip stored under the batch's key is found by the CLI
    for (let i = 0; i < 2; i++) seed(normalizeJob({ ...params, node: "s1a" }), i);
    const r = await run(argvFor({ sparsity: 0.75, candidates: 2, pick: 1 }));
    expect(r.exitCode).toBe(0);
    const rec = JSON.parse(readFileSync(p.dir + "/build/s1a.colab.json", "utf8"));
    expect(rec.winner.cacheKey).toBe(batchKeys[1]!);
    expect(rec.winner).toMatchObject({ index: 1, seed: 20261018, selectedBy: "params.pick" });
    expect(rec.candidates.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(rec.params).toMatchObject({ candidates: 2, pick: 1, seed: 20261017 });
  });

  test("pick is not part of the key, the prompt is", () => {
    const base = jobKeyInfo(tpl, job({ candidates: 2 }), 1, resolveInputs(job(), p.dir)).key;
    expect(jobKeyInfo(tpl, job({ candidates: 2, pick: 1 }), 1, resolveInputs(job(), p.dir)).key).toBe(base);
    expect(jobKeyInfo(tpl, job({ candidates: 2, prompt: "other <Picture 1>" }), 1, resolveInputs(job(), p.dir)).key).not.toBe(base);
  });
});

describe("materialize: candidates", () => {
  test("candidates > 1 without pick: exit 2, hint lists every candidate's cache path, nothing written", async () => {
    const j = job({ candidates: 2 });
    const k0 = seed(j, 0);
    const k1 = jobCacheKey(tpl, j, 1, resolveInputs(j, p.dir)); // not generated
    const r = await run([...argvFor({ candidates: 2 }), "--json"]);
    expect(r.exitCode).toBe(2);
    const err = JSON.parse(r.stderr).errors[0];
    expect(err).toMatchObject({ code: "needs-pick", field: "pick" });
    expect(err.hint).toContain(`.colab-comfy/cache/${k0.slice(0, 2)}/${k0}/clip.mp4`);
    expect(err.hint).toContain(`${k1}/clip.mp4`);
    expect(err.hint).toContain("[not generated]");
    expect(files()).toEqual({ out: false, record: false });
  });

  test("pick >= candidates is invalid input", async () => {
    expect((await run(argvFor({ candidates: 2, pick: 2 }))).exitCode).toBe(2);
  });

  test("a pick whose clip is missing is a cache miss (exit 5), not a fallback to another candidate", async () => {
    const j = job({ candidates: 2 });
    seed(j, 0);
    const r = await run(argvFor({ candidates: 2, pick: 1 }));
    expect(r.exitCode).toBe(5);
    expect(files()).toEqual({ out: false, record: false });
  });
});

describe("materialize: failures leave nothing behind", () => {
  test("cache miss without COLAB_COMFY_YES: exit 5 with the cost hint; no produce files; no colab call", async () => {
    const state = join(p.dir, "fake-state");
    const env = fakeColabEnv(state);
    const r = await run([...argvFor(), "--json"], env);
    expect(r.exitCode).toBe(5);
    const err = JSON.parse(r.stderr).errors[0];
    expect(err.code).toBe("needs-confirmation");
    expect(err.hint).toMatch(/≈0\.\d\d CU for 1 job/);
    expect(err.hint).toContain("colab-comfy batch");
    expect(err.hint).toContain("COLAB_COMFY_YES=1 filmkit run s1a");
    expect(files()).toEqual({ out: false, record: false });
    expect(readCalls(state)).toEqual([]);
  });

  test("COLAB_COMFY_YES=1 does not override the budget: exit 5, still no colab call", async () => {
    const state = join(p.dir, "fake-state");
    const r = await run([...argvFor(), "--budget=0.1", "--json"], fakeColabEnv(state, { COLAB_COMFY_YES: "1" }));
    expect(r.exitCode).toBe(5);
    expect(JSON.parse(r.stderr).errors[0].code).toBe("over-budget");
    expect(readCalls(state)).toEqual([]);
    expect(files()).toEqual({ out: false, record: false });
  });

  test("a clip that does not match its meta sha256: exit 1, no outputs, hint names the entry", async () => {
    const key = seed(job(), 0);
    writeFileAtomic(cachePaths(p.dir, key).clip, "tampered");
    const r = await run([...argvFor(), "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr).errors[0].hint).toContain(key.slice(0, 2));
    expect(files()).toEqual({ out: false, record: false });
  });

  test("an unwritable --record target: exit 1, the video is not left without its record", async () => {
    seed(job(), 0);
    p.write("blocker", "i am a file");
    const r = await run(argvFor({}, "./build/s1a.mp4", "./blocker/s1a.colab.json"));
    expect(r.exitCode).toBe(1);
    expect(files().out).toBe(false);
    expect(existsSync(p.dir + "/build/s1a.mp4.part")).toBe(false);
  });

  test("missing --out / --record and a bad suffix are invalid input", async () => {
    seed(job(), 0);
    expect((await run(argvFor().filter((a) => !a.startsWith("--out=")))).exitCode).toBe(2);
    expect((await run(argvFor().filter((a) => !a.startsWith("--record=")))).exitCode).toBe(2);
    expect((await run(argvFor({}, "./build/s1a.mov"))).exitCode).toBe(2);
    expect(files()).toEqual({ out: false, record: false });
  });
});
