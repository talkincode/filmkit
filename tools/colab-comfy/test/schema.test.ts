// schema/jobs.schema.json + schema/status.schema.json against REAL documents: jobs.json from bundle.ts
// buildJobsDoc() (what the host uploads) and status.json from the real vm/fk_runner.py run against the mock
// ComfyUI (one successful job + one OOM job, so both job shapes are covered). No colab, no network, no GPU.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJobs, type PlanJson } from "../src/batch.ts";
import { buildJobsDoc, VM_DIR, writeBundle } from "../src/bundle.ts";
import { makeSampleMp4, startMockComfy, type MockComfy } from "./mock-comfy.ts";
import { BASE_JOB, fakePng, tmpProject } from "./support.ts";

const SCHEMA_DIR = join(import.meta.dir, "..", "schema");
const load = (f: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateJobs = ajv.compile(load("jobs.schema.json"));
const validateStatus = ajv.compile(load("status.schema.json"));
const errors = (v: { errors?: unknown }) => JSON.stringify(v.errors, null, 2);

const hasPython = Bun.which("python3") !== null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const P = { template: BASE_JOB.template, prompt: BASE_JOB.prompt, ref: "./refs/a.png", seed: BASE_JOB.seed, duration: 4.05, resolution: BASE_JOB.resolution };
const plan: PlanJson = {
  film: "f",
  nodes: [
    { id: "s0", status: "missing", profile: { name: "colab-comfy" }, task: "t", params: P, inputs: {} },
    { id: "s1", status: "missing", profile: { name: "colab-comfy" }, task: "t", params: { ...P, seed: 7, sparsity: 0.75 }, inputs: {} },
  ],
};

describe("jobs.schema.json (real buildJobsDoc output)", () => {
  test("a dense + a VSA job validate; unknown fields, bad keys and a missing workflow are rejected", () => {
    const proj = tmpProject();
    try {
      proj.write("refs/a.png", fakePng("a"));
      const { selected } = collectJobs(plan, proj.dir);
      const { doc } = buildJobsDoc({ session: "fk-schema", nodes: selected, baseDir: proj.dir, limits: { hardDeadlineEpoch: 1792345678 } });
      expect(doc.jobs.map((j) => j.variant)).toEqual(["dense", "vsa-0.75"]);
      expect(validateJobs(doc), errors(validateJobs)).toBe(true);

      const clone = () => JSON.parse(JSON.stringify(doc));
      const extra = clone();
      extra.jobs[0].gpu = "L4";
      expect(validateJobs(extra)).toBe(false);
      const badKey = clone();
      badKey.jobs[0].key = "nope";
      expect(validateJobs(badKey)).toBe(false);
      const noWorkflow = clone();
      delete noWorkflow.jobs[1].workflow;
      expect(validateJobs(noWorkflow)).toBe(false);
      const secret = clone();
      secret.secrets = { HF_TOKEN: "x" };
      expect(validateJobs(secret)).toBe(false);
    } finally {
      proj.cleanup();
    }
  });
});

const d = hasPython ? describe : describe.skip;

d("status.schema.json (real fk_runner.py output)", () => {
  let sampleDir = "";
  let sample = "";
  const live: { mock: MockComfy; base: string; root: string }[] = [];
  beforeAll(async () => {
    sampleDir = mkdtempSync(join(tmpdir(), "colab-comfy-sample-"));
    sample = await makeSampleMp4(sampleDir);
  });
  afterAll(() => rmSync(sampleDir, { recursive: true, force: true }));
  afterEach(() => {
    for (const h of live.splice(0)) {
      try {
        process.kill(Number(readFileSync(join(h.root, "runner.pid"), "utf8")), "SIGKILL");
      } catch {}
      h.mock.stop();
      rmSync(h.base, { recursive: true, force: true });
    }
  });

  async function py(script: string, env: Record<string, string>): Promise<string> {
    const p = Bun.spawn(["python3", join(VM_DIR, script)], { env: { ...(process.env as Record<string, string>), ...env }, stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return out;
  }

  test("done + failed(oom) status.json and the poll line (runnerAlive) validate; the real jobs.json from the bundle too", async () => {
    const proj = tmpProject();
    const base = mkdtempSync(join(tmpdir(), "colab-comfy-schema-"));
    const root = join(base, "fk");
    const comfyOut = join(base, "out");
    mkdirSync(root, { recursive: true });
    mkdirSync(comfyOut, { recursive: true });
    const mock = startMockComfy({ outputDir: comfyOut, mode: ["ok", "oom"], sampleMp4: sample });
    live.push({ mock, base, root });
    try {
      proj.write("refs/a.png", fakePng("a"));
      const { selected } = collectJobs(plan, proj.dir);
      const built = buildJobsDoc({ session: "fk-schema", nodes: selected, baseDir: proj.dir, limits: { setupTimeoutSec: 30, comfyStartTimeoutSec: 10, jobTimeoutSec: 30 } });
      await writeBundle({ built, outFile: join(root, "bundle.tar.gz") });
      const env = {
        PYTHONDONTWRITEBYTECODE: "1", FK_ROOT: root, FK_FAKE_SETUP: "1", FK_COMFY_URL: mock.url,
        FK_COMFY_INPUT_DIR: join(base, "in"), FK_COMFY_OUTPUT_DIR: comfyOut,
        FK_POLL_SEC: "0.05", FK_STATUS_EVERY: "0.3", FK_WATCHDOG_TICK: "0.1", FK_COMFY_DEAD_SEC: "1",
      };
      const kick = await py("fk_kick.py", env);
      expect(kick).toContain("FKSTATUS");

      let status: any = null;
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        try {
          status = JSON.parse(readFileSync(join(root, "status.json"), "utf8"));
          if (status.phase === "done" || status.phase === "failed") break;
        } catch {}
        await sleep(50);
      }
      expect(status?.phase).toBe("done");
      expect(status.jobs.map((j: any) => j.state)).toEqual(["done", "failed"]);
      expect(status.jobs[1].error.kind).toBe("oom");
      expect(validateStatus(status), errors(validateStatus)).toBe(true);

      const line = (await py("fk_poll.py", env)).split("\n").find((l) => l.startsWith("FKSTATUS "))!;
      const polled = JSON.parse(line.slice("FKSTATUS ".length));
      expect(polled.runnerAlive).toBe(true);
      expect(validateStatus(polled), errors(validateStatus)).toBe(true);

      // the jobs.json the VM actually read (extracted from the real bundle) is the document that validates
      const tar = Bun.spawn(["tar", "-xzOf", join(root, "bundle.tar.gz"), "./jobs.json"], { stdout: "pipe" });
      const jobsJson = JSON.parse(await new Response(tar.stdout).text());
      expect(validateJobs(jobsJson), errors(validateJobs)).toBe(true);
      expect(jobsJson.jobs.map((j: any) => j.key)).toEqual(status.jobs.map((j: any) => j.key));

      // the schema is not vacuous
      const extra = JSON.parse(JSON.stringify(status));
      extra.jobs[0].secret = "x";
      expect(validateStatus(extra)).toBe(false);
      const badPhase = { ...status, phase: "finished" };
      expect(validateStatus(badPhase)).toBe(false);
      const doneWithoutOutput = JSON.parse(JSON.stringify(status));
      doneWithoutOutput.jobs[0].output = null;
      expect(validateStatus(doneWithoutOutput)).toBe(false);
    } finally {
      proj.cleanup();
    }
  }, 40_000);
});
