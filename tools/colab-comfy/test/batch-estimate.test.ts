// `colab-comfy batch --estimate` against the REAL `filmkit plan --json` on a temp
// project (the EP03 example film). A fake `colab` on PATH logs every call: the
// estimate must make none (PLAN §8.1 M2 "no colab call").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cachePaths, writeFileAtomic } from "../src/cache.ts";
import { main } from "../src/cli.ts";
import type { EstimateReport } from "../src/batch.ts";
import { fakePng, tmpProject } from "./support.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO, "tools/colab-comfy/examples/ep03-test/filmkit.yaml"), "utf8");
const PROFILE = readFileSync(join(REPO, "profiles/colab-comfy.yaml"), "utf8");
const FILMKIT = `bun ${join(REPO, "bin/filmkit.ts")}`;

let p: ReturnType<typeof tmpProject>;
let shim: ReturnType<typeof tmpProject>;
let colabLog: string;
let prevPath: string | undefined;

beforeAll(() => {
  shim = tmpProject();
  colabLog = join(shim.dir, "colab.log");
  // `colab` must never run during an estimate: record any call.
  const colab = shim.write("colab", `#!/bin/sh\necho "$@" >> "${colabLog}"\nexit 0\n`);
  // the Profile's delegated `validate` calls this binary by name
  const cc = shim.write("colab-comfy", `#!/bin/sh\nexec bun "${join(REPO, "tools/colab-comfy/bin/colab-comfy.ts")}" "$@"\n`);
  chmodSync(colab, 0o755);
  chmodSync(cc, 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${prevPath}`;

  p = tmpProject();
  p.write("filmkit.yaml", EXAMPLE);
  p.write("profiles/colab-comfy.yaml", PROFILE);
  for (const r of ["ff_yM", "ff_bM", "ff_bC"]) p.write(`refs/${r}.png`, fakePng(r));
});
afterAll(() => {
  process.env.PATH = prevPath;
  p.cleanup();
  shim.cleanup();
});

const estimate = async (...args: string[]) => {
  const r = await main(["batch", "--estimate", "--json", "--filmkit", FILMKIT, ...args], {}, p.dir);
  return { ...r, report: r.stdout ? (JSON.parse(r.stdout) as EstimateReport) : undefined };
};
const colabCalls = () => (existsSync(colabLog) ? readFileSync(colabLog, "utf8").trim() : "");

describe("batch --estimate on the EP03 example", () => {
  test("filmkit validate accepts the example (delegated validate ran)", () => {
    const r = Bun.spawnSync(["bun", join(REPO, "bin/filmkit.ts"), "validate", "--json"], { cwd: p.dir, env: process.env });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ ok: true, nodes: 3 });
  }, 20_000);

  test("3 jobs: frames 107/141/124 (5.0 s -> 124; shots.json's 141 was FL2VA), ~0.75 CU, needs confirmation (exit 5), no colab call", async () => {
    const r = await estimate();
    expect(r.exitCode).toBe(5);
    const rep = r.report!;
    expect(rep.nodes.map((n) => [n.id, n.variant, n.frames])).toEqual([["s1a", "dense", 107], ["s3a", "vsa-0.75", 141], ["s4a", "vsa-0.5", 124]]);
    expect(rep.jobsToGenerate).toBe(3);
    expect(rep.jobsCached).toBe(0);
    // 0.77 is the 141-frame s4a of PLAN §6.5 (see estimate.test.ts); this film's s4a is 124 frames
    expect(Math.abs(rep.estimate.cu - 0.75)).toBeLessThanOrEqual(0.01);
    expect(rep.gate.decision).toBe("needs-confirmation");
    expect(rep.gate.reasons.map((x) => x.code)).toEqual(["batch-needs-yes"]);
    expect(colabCalls()).toBe("");
  }, 30_000);

  test("--yes within budget: proceed (exit 0)", async () => {
    const r = await estimate("--yes");
    expect(r.exitCode).toBe(0);
    expect(r.report!.gate.decision).toBe("proceed");
  }, 30_000);

  test("--budget below the estimate: exit 5 even with --yes, hint names a bigger budget", async () => {
    const r = await estimate("--yes", "--budget", "0.5");
    expect(r.exitCode).toBe(5);
    expect(r.report!.gate.reasons.map((x) => x.code)).toEqual(["over-budget"]);
    expect(r.report!.gate.reasons[0]!.hint).toContain("--budget 0.8");
  }, 30_000);

  test("COLAB_COMFY_BUDGET_CU is honoured", async () => {
    const r = await main(["batch", "--estimate", "--json", "--yes", "--filmkit", FILMKIT], { COLAB_COMFY_BUDGET_CU: "0.5" }, p.dir);
    expect(r.exitCode).toBe(5);
  }, 30_000);

  test("text output lists the breakdown and the gate", async () => {
    const r = await main(["batch", "--estimate", "--filmkit", FILMKIT], {}, p.dir);
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toContain("estimate: 0.75 CU for 3 job(s)");
    expect(r.stdout).toContain("gate: needs confirmation (exit 5)");
    expect(r.stdout).toContain("s3a#0 vsa-0.75");
  }, 30_000);

  test("--nodes s1a: one job, ~0.54 CU, proceeds without --yes", async () => {
    const r = await estimate("--nodes", "s1a");
    expect(r.exitCode).toBe(0);
    expect(r.report!.nodes.map((n) => n.id)).toEqual(["s1a"]);
    expect(r.report!.estimate.cu).toBeGreaterThan(0.5);
    expect(r.report!.estimate.cu).toBeLessThan(0.58);
  }, 30_000);

  test("a cache hit is skipped and lowers the estimate; all hits -> nothing to generate, 0 CU", async () => {
    const first = (await estimate()).report!;
    const s1a = first.nodes.find((n) => n.id === "s1a")!.candidates[0]!;
    const paths = cachePaths(p.dir, s1a.key);
    writeFileAtomic(paths.clip, "clip");
    writeFileAtomic(paths.meta, "{}");
    try {
      const two = await estimate("--yes");
      expect(two.report!.jobsToGenerate).toBe(2);
      expect(two.report!.jobsCached).toBe(1);
      expect(two.report!.nodes[0]!.candidates[0]!.cached).toBe(true);
      expect(two.report!.estimate.cu).toBeLessThan(first.estimate.cu);

      for (const n of first.nodes) {
        for (const c of n.candidates) {
          const cp = cachePaths(p.dir, c.key);
          writeFileAtomic(cp.clip, "clip");
          writeFileAtomic(cp.meta, "{}");
        }
      }
      const none = await estimate();
      expect(none.exitCode).toBe(0);
      expect(none.report!.jobsToGenerate).toBe(0);
      expect(none.report!.estimate.cu).toBe(0);
      const text = await main(["batch", "--estimate", "--filmkit", FILMKIT], {}, p.dir);
      expect(text.stdout).toContain("nothing to generate");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(join(p.dir, ".colab-comfy"), { recursive: true, force: true });
    }
    expect(colabCalls()).toBe("");
  }, 60_000);

  test("candidates expand to seed+i; with pick only the picked candidate is expanded", async () => {
    const orig = readFileSync(join(p.dir, "filmkit.yaml"), "utf8");
    try {
      writeFileSync(join(p.dir, "filmkit.yaml"), orig.replace("sparsity: 0\n", "sparsity: 0\n        candidates: 3\n"));
      const all = (await estimate("--nodes", "s1a", "--yes")).report!;
      expect(all.nodes[0]!.candidates.map((c) => [c.index, c.seed])).toEqual([[0, 20261017], [1, 20261018], [2, 20261019]]);
      expect(all.jobsToGenerate).toBe(3);
      expect(new Set(all.nodes[0]!.candidates.map((c) => c.key)).size).toBe(3);

      writeFileSync(join(p.dir, "filmkit.yaml"), orig.replace("sparsity: 0\n", "sparsity: 0\n        candidates: 3\n        pick: 1\n"));
      const picked = (await estimate("--nodes", "s1a")).report!;
      expect(picked.nodes[0]!.candidates.map((c) => [c.index, c.seed])).toEqual([[1, 20261018]]);
      // candidate 0 key is unchanged by candidates/pick (PLAN §6.1)
      expect(picked.nodes[0]!.candidates[0]!.key).toBe(all.nodes[0]!.candidates[1]!.key);
    } finally {
      writeFileSync(join(p.dir, "filmkit.yaml"), orig);
    }
  }, 60_000);

  test("a missing ref is invalid input (exit 2) naming the node and field, before any spend", async () => {
    const { renameSync } = await import("node:fs");
    renameSync(join(p.dir, "refs/ff_bM.png"), join(p.dir, "refs/ff_bM.png.moved"));
    try {
      const r = await estimate();
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stderr).errors[0]).toMatchObject({ code: "invalid-input", field: "s3a.ref" });
    } finally {
      renameSync(join(p.dir, "refs/ff_bM.png.moved"), join(p.dir, "refs/ff_bM.png"));
    }
    expect(colabCalls()).toBe("");
  }, 30_000);

  test("filmkit not found: exit 3; filmkit plan failing (no such film): its exit code 1 is passed through", async () => {
    const missing = await main(["batch", "--estimate", "--json", "--filmkit", "definitely-not-filmkit"], {}, p.dir);
    expect(missing.exitCode).toBe(3);
    const bad = await main(["batch", "--estimate", "--json", "--film", "./nope.yaml", "--filmkit", FILMKIT], {}, p.dir);
    expect(bad.exitCode).toBe(1); // filmkit's io code, passed through
    expect(JSON.parse(bad.stderr).errors[0].code).toBe("filmkit-plan-failed");
  }, 30_000);

  test("non-L4 GPU without --rate: exit 2; with --rate but no --yes: exit 5", async () => {
    expect((await estimate("--gpu", "A100")).exitCode).toBe(2);
    const r = await estimate("--gpu", "A100", "--rate", "5");
    expect(r.exitCode).toBe(5);
    expect(r.report!.gate.reasons.map((x) => x.code)).toContain("gpu-needs-rate");
  }, 30_000);
});
