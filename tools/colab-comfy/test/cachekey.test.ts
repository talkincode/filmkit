import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cacheHit, cachePaths, jobCacheKey, writeFileAtomic } from "../src/cache.ts";
import { resolveRefs } from "../src/job.ts";
import { existsSync, readFileSync } from "node:fs";
import { fakePng, makeJob, tmpProject, tpl } from "./support.ts";

let p: ReturnType<typeof tmpProject>;
beforeAll(() => {
  p = tmpProject();
  p.write("refs/a.png", fakePng("a"));
  p.write("refs/a-renamed.png", fakePng("a")); // same bytes, different path
  p.write("refs/a2.png", fakePng("a-but-different")); // different bytes
  p.write("refs/b.png", fakePng("b"));
});
afterAll(() => p.cleanup());

function key(over: Record<string, unknown> = {}, candidate = 0, template = tpl): string {
  const job = makeJob(over);
  return jobCacheKey(template, job, candidate, resolveRefs(job, p.dir));
}

describe("cache key (PLAN §6.1)", () => {
  let base = "";
  beforeAll(() => {
    base = key();
  });

  test("is a stable sha256, pinned: a change here means every cached clip would be orphaned", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).toBe("cc487f9bb434b0c519bde592a936b2d5bb3fdd6ac1b31ec25bc55304948907d6");
    expect(key()).toBe(base);
  });

  const same: [string, Record<string, unknown>][] = [
    ["pick", { candidates: 3, pick: 0 }],
    ["candidates 1 -> 3 (candidate 0 unchanged)", { candidates: 3 }],
    ["node id", { node: "other" }],
    ["ref path with identical bytes", { ref: "./refs/a-renamed.png" }],
    ["duration inside the same frame bucket (4.0s and 4.05s are both 107 frames)", { duration: 4.0 }],
  ];
  for (const [name, over] of same) test(`unchanged by ${name}`, () => expect(key(over)).toBe(base));

  const changes: [string, Record<string, unknown>][] = [
    ["prompt", { prompt: "The woman from <Picture 1> waves." }],
    ["seed", { seed: 20261018 }],
    ["duration across a frame bucket (5.28s = 141 frames)", { duration: 5.28 }],
    ["resolution", { resolution: "768x1344" }],
    ["sparsity 0 -> 0.75", { sparsity: 0.75 }],
    ["sparsity 0 -> 0.5", { sparsity: 0.5 }],
    ["ref content", { ref: "./refs/a2.png" }],
    ["adding a second ref", { ref2: "./refs/b.png" }],
  ];
  for (const [name, over] of changes) test(`changed by ${name}`, () => expect(key(over)).not.toBe(base));

  test("all single-field changes give pairwise distinct keys", () => {
    const keys = new Set([base, ...changes.map(([, o]) => key(o))]);
    expect(keys.size).toBe(changes.length + 1);
  });

  test("candidate i has the key of the same job with seed + i", () => {
    expect(key({ candidates: 3 }, 1)).toBe(key({ seed: 20261018 }, 0));
    expect(key({ candidates: 3 }, 1)).not.toBe(key({ candidates: 3 }, 0));
  });

  test("a different manifest (template @N bump) changes every key", () => {
    const bumped = { ...tpl, manifestSha256: "0".repeat(64) };
    expect(key({}, 0, bumped)).not.toBe(base);
  });

  test("a different template file changes the key", () => {
    const edited = { ...tpl, variants: { ...tpl.variants, dense: { ...tpl.variants.dense, fileSha256: "f".repeat(64) } } };
    // workflow content is identical, only the recorded file sha differs: the key must still move
    expect(key({}, 0, edited)).not.toBe(base);
  });
});

describe("cache paths and atomic writes", () => {
  test("layout and hit rule (both files needed)", () => {
    const k = key();
    const paths = cachePaths(p.dir, k);
    expect(paths.clip).toBe(`${p.dir}/.colab-comfy/cache/${k.slice(0, 2)}/${k}/clip.mp4`);
    expect(cacheHit(p.dir, k)).toBe(false);
    writeFileAtomic(paths.clip, "clip");
    expect(cacheHit(p.dir, k)).toBe(false); // clip without meta is not a hit
    writeFileAtomic(paths.meta, "{}");
    expect(cacheHit(p.dir, k)).toBe(true);
    expect(readFileSync(paths.clip, "utf8")).toBe("clip");
    expect(existsSync(`${paths.clip}.part`)).toBe(false);
  });

  test("a failed write leaves no .part and no target", () => {
    const target = `${p.dir}/.colab-comfy/cache/zz/target-is-a-dir`;
    p.write("x", "x");
    writeFileAtomic(`${target}/f`, "x"); // makes `target` a directory
    expect(() => writeFileAtomic(target, "data")).toThrow();
    expect(existsSync(`${target}.part`)).toBe(false);
  });
});
