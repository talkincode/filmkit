// jobs.json builder + bundle writer, and the whole host<->VM chain through the fake `colab` shim:
// mkdirs -> upload bundle -> kick -> poll -> download -> stop. Real fk_*.py scripts, mock ComfyUI,
// FK_FAKE_SETUP=1 (no installs), fake colab. No GPU, no network, no money.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJobs, type PlanJson } from "../src/batch.ts";
import { buildJobsDoc, writeBundle, VM_DIR } from "../src/bundle.ts";
import { cachePaths, writeFileAtomic } from "../src/cache.ts";
import { Colab, isReleasing } from "../src/colab.ts";
import { ColabComfyError } from "../src/errors.ts";
import { fakeColabEnv, sessionContent } from "./fake-colab.ts";
import { makeSampleMp4, startMockComfy } from "./mock-comfy.ts";
import { BASE_JOB, fakePng, tmpProject } from "./support.ts";

const hasPython = Bun.which("python3") !== null;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function plan(params: Record<string, unknown>[]): PlanJson {
  return {
    film: "f",
    nodes: params.map((p, i) => ({
      id: `s${i}`, status: "missing", profile: { name: "colab-comfy" }, task: "t", params: p, inputs: {},
    })),
  };
}

const P = { template: BASE_JOB.template, prompt: BASE_JOB.prompt, ref: BASE_JOB.ref, seed: BASE_JOB.seed, duration: 4.05, resolution: BASE_JOB.resolution };

describe("buildJobsDoc / writeBundle", () => {
  let proj: ReturnType<typeof tmpProject>;
  beforeAll(() => {
    proj = tmpProject();
    proj.write("refs/a.png", fakePng("a"));
    proj.write("refs/b.png", fakePng("b"));
  });
  afterAll(() => proj.cleanup());

  test("jobs.json carries top-level requiredClasses from bindings.json, manifest, limits and one entry per candidate", () => {
    const { selected } = collectJobs(plan([{ ...P, candidates: 2 }, { ...P, ref: "./refs/b.png", sparsity: 0.75 }]), proj.dir);
    const { doc, inputs } = buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: proj.dir, limits: { hardDeadlineEpoch: 1792345678, idleTtlSec: 123 } });
    const tpl = selected[0]!.template;
    expect(doc.protocol).toBe("colab-comfy/v1");
    expect(doc.requiredClasses).toEqual(tpl.bindings.requiredClasses);
    expect(doc.requiredClasses).toContain("Ref2VAVSAGatePatch");
    expect(doc.manifest).toEqual(tpl.manifest);
    expect(doc.manifestSha256).toBe(tpl.manifestSha256);
    expect(doc.limits).toMatchObject({ hardDeadlineEpoch: 1792345678, idleTtlSec: 123, jobTimeoutSec: 900 });
    expect(doc.jobs.map((j) => [j.node, j.candidate, j.seed, j.variant])).toEqual([
      ["s0", 0, BASE_JOB.seed, "dense"], ["s0", 1, BASE_JOB.seed + 1, "dense"], ["s1", 0, BASE_JOB.seed, "vsa-0.75"],
    ]);
    // keys are exactly the ones batch announced
    expect(doc.jobs.map((j) => j.key)).toEqual(selected.flatMap((n) => n.candidates.map((c) => c.key)));
    expect([...inputs.keys()].sort()).toEqual([`${sha(fakePng("a"))}.png`, `${sha(fakePng("b"))}.png`].sort());
    for (const j of doc.jobs) expect(j.inputs[0]!.file).toBe(`${j.inputs[0]!.sha256}.png`);
    expect(JSON.stringify(doc)).not.toMatch(/secret|token/i);
  });

  test("cached candidates are skipped; all cached is an error", () => {
    const { selected } = collectJobs(plan([{ ...P, candidates: 2 }]), proj.dir);
    const k0 = selected[0]!.candidates[0]!.key;
    const cp = cachePaths(proj.dir, k0);
    writeFileAtomic(cp.clip, "x");
    writeFileAtomic(cp.meta, "{}");
    try {
      const again = collectJobs(plan([{ ...P, candidates: 2 }]), proj.dir).selected;
      const { doc } = buildJobsDoc({ session: "fk-t", nodes: again, baseDir: proj.dir });
      expect(doc.jobs.map((j) => j.candidate)).toEqual([1]);
      const one = collectJobs(plan([{ ...P, candidates: 1 }]), proj.dir).selected;
      expect(() => buildJobsDoc({ session: "fk-t", nodes: one, baseDir: proj.dir })).toThrow(ColabComfyError);
    } finally {
      rmSync(cp.dir, { recursive: true, force: true });
    }
  });

  test("a ref that changes after planning is detected (key mismatch), not silently cached under the old key", () => {
    proj.write("refs/c.png", fakePng("c1"));
    const { selected } = collectJobs(plan([{ ...P, ref: "./refs/c.png" }]), proj.dir);
    proj.write("refs/c.png", fakePng("c2"));
    expect(() => buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: proj.dir })).toThrow(/key/);
  });

  test("identical content under two nodes is generated once", () => {
    const { selected } = collectJobs(plan([P, P]), proj.dir);
    const { doc } = buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: proj.dir });
    expect(doc.jobs.length).toBe(1);
  });

  test("writeBundle: tar has vm/*.py, jobs.json, manifest.json, inputs/; secrets.env only on request (0600); atomic", async () => {
    const { selected } = collectJobs(plan([P]), proj.dir);
    const built = buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: proj.dir });
    const out = join(proj.dir, "bundles", "plain.tar.gz");
    await writeBundle({ built, outFile: out });
    expect(existsSync(`${out}.part`)).toBe(false);
    const list = (await new Response(Bun.spawn(["tar", "-tzf", out], { stdout: "pipe" }).stdout).text()).split("\n").map((l) => l.replace(/^\.\//, ""));
    for (const f of ["jobs.json", "manifest.json", "vm/fk_kick.py", "vm/fk_poll.py", "vm/fk_runner.py", "vm/fk_setup.py", `inputs/${sha(fakePng("a"))}.png`]) {
      expect(list).toContain(f);
    }
    expect(list).not.toContain("secrets.env");

    const out2 = join(proj.dir, "bundles", "secret.tar.gz");
    await writeBundle({ built, outFile: out2, secretsEnv: "HF_TOKEN=hf_FAKEFAKEFAKE\n" });
    const x = mkdtempSync(join(tmpdir(), "colab-comfy-x-"));
    try {
      await Bun.spawn(["tar", "-xzf", out2, "-C", x]).exited;
      expect(statSync(join(x, "secrets.env")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(x, "jobs.json"), "utf8")).requiredClasses.length).toBeGreaterThan(0);
      expect(readFileSync(join(x, "jobs.json"), "utf8")).not.toContain("hf_FAKE");
    } finally {
      rmSync(x, { recursive: true, force: true });
    }
  });

  test("writeBundle failure leaves neither a target nor a .part", async () => {
    const { selected } = collectJobs(plan([P]), proj.dir);
    const built = buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: proj.dir });
    const out = join(proj.dir, "bundles", "bad.tar.gz");
    await expect(writeBundle({ built, outFile: out, vmDir: join(proj.dir, "no-vm-here") })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });
});

const d = hasPython ? describe : describe.skip;

d("host <-> VM chain through the fake colab shim", () => {
  let sampleDir = "";
  let sample = "";
  const cleanup: (() => void)[] = [];
  beforeAll(async () => {
    sampleDir = mkdtempSync(join(tmpdir(), "colab-comfy-sample-"));
    sample = await makeSampleMp4(sampleDir);
  });
  afterAll(() => rmSync(sampleDir, { recursive: true, force: true }));
  afterEach(() => cleanup.splice(0).forEach((f) => f()));

  async function setup(limits: Record<string, number> = {}, extraEnv: Record<string, string> = {}) {
    const proj = tmpProject();
    proj.write("refs/a.png", fakePng("chain"));
    const state = join(proj.dir, "state");
    const comfyOut = join(proj.dir, "ComfyUI", "output");
    const comfyIn = join(proj.dir, "ComfyUI", "input");
    mkdirSync(comfyOut, { recursive: true });
    const mock = startMockComfy({ outputDir: comfyOut, sampleMp4: sample });
    const colab = new Colab({
      env: fakeColabEnv(state, {
        FK_FAKE_SETUP: "1", FK_COMFY_URL: mock.url, FK_COMFY_INPUT_DIR: comfyIn, FK_COMFY_OUTPUT_DIR: comfyOut,
        FK_POLL_SEC: "0.05", FK_STATUS_EVERY: "0.5", FK_WATCHDOG_TICK: "0.1", FK_COMFY_DEAD_SEC: "1",
        ...extraEnv,
      }),
    });
    cleanup.push(() => {
      // the runner is a detached process in the fake VM: never leave it behind
      try {
        process.kill(Number(readFileSync(join(sessionContent(state, "fk-chain"), "fk", "runner.pid"), "utf8")), "SIGKILL");
      } catch {}
      mock.stop();
      proj.cleanup();
    });
    const { selected } = collectJobs(plan([{ ...P, ref: "./refs/a.png", candidates: 2 }]), proj.dir);
    const built = buildJobsDoc({ session: "fk-chain", nodes: selected, baseDir: proj.dir, limits: { setupTimeoutSec: 30, comfyStartTimeoutSec: 10, jobTimeoutSec: 30, ...limits } });
    return { proj, state, colab, mock, built };
  }

  test("mkdirs -> upload bundle -> kick -> poll until done -> download both clips -> stop -> verified gone", async () => {
    const { proj, state, colab, built } = await setup();
    const bundle = join(proj.dir, "bundle.tar.gz");
    await writeBundle({ built, outFile: bundle });

    expect((await colab.newSession("fk-chain", "L4")).ok).toBe(true);
    const mk = await colab.exec("fk-chain", join(VM_DIR, "fk_mkdirs.py"), 20);
    expect(mk.fkstatus).toMatchObject({ ok: true });
    expect((await colab.upload("fk-chain", bundle, "/content/fk/bundle.tar.gz")).ok).toBe(true);
    const kick = await colab.exec("fk-chain", join(VM_DIR, "fk_kick.py"), 30);
    expect(kick.fkstatus).toMatchObject({ ok: true, kicked: true });

    let st: any = null;
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const r = await colab.exec("fk-chain", join(VM_DIR, "fk_poll.py"), 20);
      st = r.fkstatus;
      if (st && ["done", "failed", "aborted"].includes(st.phase)) break;
      await sleep(200);
    }
    expect(st.phase).toBe("done");
    expect(isReleasing(st)).toBe(false);
    expect(st.jobs.map((j: any) => j.state)).toEqual(["done", "done"]);

    for (const j of st.jobs) {
      const dest = join(proj.dir, "dl", "x", `${j.key}.mp4`);
      const dl = await colab.download("fk-chain", `/content/fk/out/${j.key}.mp4`, dest);
      expect(dl.ok).toBe(true);
      expect(sha(readFileSync(dest))).toBe(j.output.sha256);
    }
    expect((await colab.stop("fk-chain")).ok).toBe(true);
    expect(await colab.sessions()).toEqual([]);
    expect((await colab.usage()).assignments).toBe(0);
    expect(existsSync(join(sessionContent(state, "fk-chain"), "fk", "release.request"))).toBe(false);
  }, 40000);

  async function startChain(limits: Record<string, number>, extraEnv: Record<string, string>) {
    const c = await setup(limits, extraEnv);
    const bundle = join(c.proj.dir, "bundle.tar.gz");
    await writeBundle({ built: c.built, outFile: bundle });
    await c.colab.newSession("fk-chain", "L4");
    await c.colab.exec("fk-chain", join(VM_DIR, "fk_mkdirs.py"), 20);
    await c.colab.upload("fk-chain", bundle, "/content/fk/bundle.tar.gz");
    await c.colab.exec("fk-chain", join(VM_DIR, "fk_kick.py"), 30);
    return c;
  }
  const pastDeadline = () => ({ hardDeadlineEpoch: Math.floor(Date.now() / 1000) - 5 });

  test("fallback: the runner's own unassign did NOT work -> the next poll says releasing:true and the kernel-side unassign removes the session", async () => {
    // FK_SELF_RELEASE_MARKER makes the runner's self_release a no-op marker write, i.e. "unassign from a detached process failed"
    const marker = join(tmpdir(), `fk-marker-${process.pid}-${Date.now()}.json`);
    cleanup.push(() => rmSync(marker, { force: true }));
    const { colab } = await startChain(pastDeadline(), { FK_SELF_RELEASE_MARKER: marker });

    let st: any = null;
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      st = (await colab.exec("fk-chain", join(VM_DIR, "fk_poll.py"), 20)).fkstatus;
      if (isReleasing(st)) break;
      await sleep(200);
    }
    expect(isReleasing(st)).toBe(true);
    expect(st.watchdog.reason).toBe("hard-deadline");
    expect(existsSync(marker)).toBe(true);
    expect(await colab.sessions()).toEqual([]); // the poll cell called google.colab.runtime.unassign()
    expect((await colab.usage()).assignments).toBe(0);
    // the host's STOP/VERIFY that follows is a harmless no-op
    expect(await colab.stop("fk-chain")).toMatchObject({ ok: true, notFound: true });
  }, 40000);

  test("the runner's own unassign works from a detached process in the shim: polls then report sessionNotFound", async () => {
    const { colab } = await startChain(pastDeadline(), {});
    let gone = false;
    const end = Date.now() + 20000;
    while (Date.now() < end && !gone) {
      gone = (await colab.exec("fk-chain", join(VM_DIR, "fk_poll.py"), 20)).sessionNotFound;
      await sleep(200);
    }
    expect(gone).toBe(true);
    expect(await colab.sessions()).toEqual([]);
  }, 40000);
});
