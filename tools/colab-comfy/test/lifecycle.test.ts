// Session lifecycle, guard, ledger, batch and reap (PLAN §8.1 L1-L15) against the FAKE colab shim, the REAL
// VM scripts (FK_FAKE_SETUP=1) and the mock ComfyUI. No real `colab`, no network, no money.
//
// Every test ends by asserting the fake's final `sessions` is empty (L8 first asserts SESSION_LEAK, then reaps).
// Timings are tiny via env (poll 0.2 s, guard tick 200 ms, backoff 50 ms) but nothing races on them: jobs that must
// stay unfinished use the mock's `hang` mode, and tests wait on observable state, not on sleeps.
//
// L14 (VM idle watchdog on its own): covered by runner.test.ts ("watchdog: stale/missing host heartbeat ..." and
// "self-release fallback"); here the host side of it is tested (L14b: a releasing VM -> salvage, STOP, VERIFY).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BatchReport } from "../src/batch.ts";
import { cachePaths } from "../src/cache.ts";
import { sha256File } from "../src/canonical.ts";
import { main } from "../src/cli.ts";
import { Colab } from "../src/colab.ts";
import { acquireBatchLock, activePath, pidAlive, readActive, readLedger, stateDir, writeActive } from "../src/ledger.ts";
import { classifySessions } from "../src/reap.ts";
import { computeDeadlineMs, sessionName } from "../src/session.ts";
import { backoffFromEnv } from "../src/teardown.ts";
import { fakeColabEnv, readCalls } from "./fake-colab.ts";
import { makeSampleMp4, startMockComfy, type MockComfy, type MockMode } from "./mock-comfy.ts";
import { fakePng, tmpProject } from "./support.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const CLI = join(REPO, "tools/colab-comfy/bin/colab-comfy.ts");
const FILMKIT = `bun ${join(import.meta.dir, "fake-filmkit.ts")}`;
const hasPython = Bun.which("python3") !== null;
if (!hasPython) console.warn("SKIP lifecycle.test.ts session tests: python3 not found on PATH");
const d = hasPython ? describe : describe.skip;

let sampleDir = "";
let sample = "";
beforeAll(async () => {
  sampleDir = mkdtempSync(join(tmpdir(), "colab-comfy-sample-"));
  sample = await makeSampleMp4(sampleDir);
});
afterAll(() => rmSync(sampleDir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (x: number) => Math.round(x * 100) / 100;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 30_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Spawned {
  proc: ReturnType<typeof Bun.spawn>;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
}

interface H {
  dir: string;
  state: string;
  mock: MockComfy;
  env: Record<string, string>;
  /** In-process `main()` for `batch`/`reap`. */
  run(args: string[], extraEnv?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string; json: any }>;
  /** The same CLI as a real subprocess (signals need one). */
  spawn(args: string[], extraEnv?: Record<string, string>): Spawned;
  batchArgs(...extra: string[]): string[];
  calls(): string[];
  callLines(): string[];
  sessions(extraEnv?: Record<string, string>): Promise<string[]>;
  clips(): number;
}

const live: { h: H; cleanup: () => void }[] = [];

afterEach(() => {
  for (const { cleanup } of live.splice(0)) cleanup();
});

interface Setup {
  nodes?: number;
  mode?: MockMode | MockMode[];
  classes?: string[];
  env?: Record<string, string>;
  /** Plan params override per node (index from 1). */
  params?: (i: number) => Record<string, unknown>;
}

function setup(o: Setup = {}): H {
  const p = tmpProject();
  const state = join(p.dir, "fake-state");
  const comfyOut = join(p.dir, "comfy-out");
  const comfyIn = join(p.dir, "comfy-in");
  p.write("refs/a.png", fakePng("a"));
  p.write("filmkit.yaml", "apiVersion: filmkit/v1alpha1\nkind: Film\nmetadata:\n  name: lifecycle-test\n");
  const n = o.nodes ?? 3;
  p.write(
    "plan.json",
    JSON.stringify({
      film: join(p.dir, "filmkit.yaml"),
      nodes: Array.from({ length: n }, (_, k) => ({
        id: `s${k + 1}`,
        status: "missing",
        profile: { name: "colab-comfy" },
        task: "h3-ref2va",
        params: {
          template: "h3-ref2va@1",
          prompt: `Scene ${k + 1}: the woman from <Picture 1> talks to the camera.`,
          ref: "./refs/a.png",
          seed: 100 + k,
          duration: 4.05,
          resolution: "704x1280",
          sparsity: 0,
          ...o.params?.(k + 1),
        },
        inputs: {},
      })),
    }),
  );
  const mock = startMockComfy({ outputDir: comfyOut, mode: o.mode, classes: o.classes, sampleMp4: sample });
  const env = fakeColabEnv(state, {
    FAKE_COLAB_CU_PER_SEC: "0.02",
    PYTHONDONTWRITEBYTECODE: "1",
    FK_FAKE_SETUP: "1",
    FK_COMFY_URL: mock.url,
    FK_COMFY_INPUT_DIR: comfyIn,
    FK_COMFY_OUTPUT_DIR: comfyOut,
    FK_POLL_SEC: "0.05",
    FK_STATUS_EVERY: "0.3",
    FK_WATCHDOG_TICK: "0.2",
    FK_COMFY_DEAD_SEC: "1",
    COLAB_COMFY_POLL_SEC: "0.2",
    COLAB_COMFY_GUARD_TICK_MS: "200",
    COLAB_COMFY_BACKOFF_MS: "50",
    COLAB_COMFY_QUIET: "1",
    COLAB_COMFY_USAGE_SEC: "100000",
    ...o.env,
  });
  const procs: Spawned["proc"][] = [];

  const h: H = {
    dir: p.dir,
    state,
    mock,
    env,
    batchArgs: (...extra) => ["batch", "--film", "./filmkit.yaml", "--filmkit", FILMKIT, "--json", ...extra],
    async run(args, extraEnv = {}) {
      const r = await main(args, { ...env, ...extraEnv }, p.dir);
      let json: any = null;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        // text output
      }
      return { ...r, json };
    },
    spawn(args, extraEnv = {}) {
      const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: p.dir, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      procs.push(proc);
      const done = (async () => {
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
        return { code: await proc.exited, stdout, stderr };
      })();
      return { proc, done };
    },
    calls: () => readCalls(state).map((c) => c.sub),
    callLines: () => readCalls(state).map((c) => c.line),
    async sessions(extraEnv = {}) {
      return (await new Colab({ env: { ...env, ...extraEnv } }).sessions()).map((s) => s.name);
    },
    clips() {
      const root = join(p.dir, ".colab-comfy", "cache");
      if (!existsSync(root)) return 0;
      let count = 0;
      for (const k2 of readdirSync(root)) for (const key of readdirSync(join(root, k2))) if (existsSync(join(root, k2, key, "meta.json")) && existsSync(join(root, k2, key, "clip.mp4"))) count++;
      return count;
    },
  };
  const cleanup = () => {
    for (const proc of procs) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    // detached guard / VM runner processes must not outlive the test
    const rec = readActive(stateDir(p.dir));
    if (rec?.guardPid) {
      try {
        process.kill(rec.guardPid, "SIGKILL");
      } catch {}
    }
    const sess = join(state, "sessions");
    if (existsSync(sess)) {
      for (const s of readdirSync(sess)) {
        try {
          process.kill(Number(readFileSync(join(sess, s, "content", "fk", "runner.pid"), "utf8")), "SIGKILL");
        } catch {}
      }
    }
    mock.stop();
    p.cleanup();
  };
  live.push({ h, cleanup });
  return h;
}

/** Fake colab's own CU counter -> what `colab usage` shows after the run. */
const fakeBalanceAfter = (h: H) => round2(100 - (JSON.parse(readFileSync(join(h.state, "ledger.json"), "utf8")) as { spent: number }).spent);
const ledger = (h: H) => readLedger(stateDir(h.dir));
const active = (h: H) => readActive(stateDir(h.dir));
const index = (subs: string[], sub: string) => subs.indexOf(sub);

// ---------------------------------------------------------------------------------------------------------
describe("pure pieces", () => {
  test("session name: fk-<film>-<UTC yyyymmddHHMM>, lowercased, <= 40 chars, timestamp kept", () => {
    const at = new Date("2026-10-18T01:47:59Z");
    expect(sessionName("ep03-h3-test", at)).toBe("fk-ep03-h3-test-202610180147");
    const long = sessionName("A Very Long Film Name That Goes On And On Forever", at);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^fk-[a-z0-9-]+-202610180147$/);
    expect(long).not.toMatch(/--/);
    expect(sessionName("***", at)).toBe("fk-film-202610180147");
  });

  test("deadline: min(max-wall, budget/rate) minus a reserve (120 s, or half of a tiny wall)", () => {
    expect(computeDeadlineMs(0, { budgetCU: 1, rateCuPerHour: 1.7 }) / 1000).toBeCloseTo(3600 / 1.7 - 120, 3);
    expect(computeDeadlineMs(0, { budgetCU: 1, rateCuPerHour: 1.7, maxWallSec: 1000 }) / 1000).toBe(880);
    expect(computeDeadlineMs(0, { budgetCU: 1, rateCuPerHour: 1.7, maxWallSec: 8 }) / 1000).toBe(4);
    expect(computeDeadlineMs(5_000, { budgetCU: 1, rateCuPerHour: 1.7, maxWallSec: 8 })).toBe(9_000);
  });

  test("backoff env: default 10/30/60 s, one number or a list", () => {
    expect(backoffFromEnv({})).toEqual([10_000, 30_000, 60_000]);
    expect(backoffFromEnv({ COLAB_COMFY_BACKOFF_MS: "50" })).toEqual([50, 50, 50]);
    expect(backoffFromEnv({ COLAB_COMFY_BACKOFF_MS: "1,2,3" })).toEqual([1, 2, 3]);
    expect(backoffFromEnv({ COLAB_COMFY_BACKOFF_MS: "junk" })).toEqual([10_000, 30_000, 60_000]);
  });

  test("classify: only fk-* recorded in active.json is ours; a live owner means running; the rest is foreign", () => {
    const s = (name: string) => ({ name, endpoint: "e", hardware: "CPU", shape: "Standard", variant: "DEFAULT" });
    const rec = { name: "fk-a", pid: 4242, deadline: 0, phase: "running" as const, film: "f", startedAt: "t" };
    const kinds = (alive: boolean) => classifySessions([s("fk-a"), s("fk-b"), s("mine")], rec, () => alive).map((c) => [c.name, c.kind]);
    expect(kinds(false)).toEqual([["fk-a", "ours-leaked"], ["fk-b", "foreign"], ["mine", "foreign"]]);
    expect(kinds(true)).toEqual([["fk-a", "running"], ["fk-b", "foreign"], ["mine", "foreign"]]);
    expect(classifySessions([s("fk-a")], null).map((c) => c.kind)).toEqual(["foreign"]);
  });

  test("batch.lock: O_EXCL, a live owner blocks, a dead owner is taken over, release only removes our own", async () => {
    const p = tmpProject();
    try {
      const dir = stateDir(p.dir);
      const release = acquireBatchLock(dir);
      expect(() => acquireBatchLock(dir, process.pid + 0)).not.toThrow(); // same pid = re-entrant take-over of our own lock
      const other = Bun.spawn(["sleep", "30"]);
      writeFileSync(join(dir, "batch.lock"), JSON.stringify({ pid: other.pid }));
      expect(() => acquireBatchLock(dir)).toThrow(/another colab-comfy batch is running/);
      other.kill("SIGKILL");
      await other.exited;
      const r2 = acquireBatchLock(dir); // dead owner: stale
      expect(JSON.parse(readFileSync(join(dir, "batch.lock"), "utf8")).pid).toBe(process.pid);
      r2();
      expect(existsSync(join(dir, "batch.lock"))).toBe(false);
      release(); // already gone: no throw
      expect(pidAlive(process.pid)).toBe(true);
      expect(pidAlive(0)).toBe(false);
    } finally {
      p.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
d("lifecycle (fake colab + real VM scripts + mock ComfyUI)", () => {
  test("L1 happy batch, 3 jobs: call order, clips cached with matching sha, ledger, actual CU, stop verified", async () => {
    const h = setup();
    const r = await h.run(h.batchArgs("--yes"));
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const rep = r.json as BatchReport;
    expect(rep.ok).toBe(true);
    const s = rep.session!;
    expect(s.outcome).toBe("ok");
    expect(s.jobsOk).toBe(3);
    expect(s.stop.verified).toBe(true);
    expect(s.session).toMatch(/^fk-lifecycle-test-\d{12}$/);

    const subs = h.calls();
    expect(subs.slice(0, 4)).toEqual(["version", "sessions", "usage", "new"]);
    expect(subs[4]).toBe("status");
    const stopAt = subs.lastIndexOf("stop");
    expect(subs.slice(stopAt + 1)).toEqual(["sessions", "usage"]); // nothing after stop except verification + usage
    expect(subs.filter((x) => x === "stop")).toHaveLength(1);
    const lines = h.callLines();
    const mkdirsAt = lines.findIndex((l) => l.includes("fk_mkdirs.py"));
    const uploadAt = lines.findIndex((l) => l.includes(" upload "));
    const kickAt = lines.findIndex((l) => l.includes("fk_kick.py"));
    const firstPollAt = lines.findIndex((l) => l.includes("fk_poll.py"));
    expect(mkdirsAt).toBeGreaterThan(0);
    expect(mkdirsAt).toBeLessThan(uploadAt); // A4: remote dir exists before the upload
    expect(uploadAt).toBeLessThan(kickAt);
    expect(kickAt).toBeLessThan(firstPollAt);
    expect(lines.filter((l) => l.includes(" upload "))[0]).toContain("/content/fk/bundle.tar.gz");
    expect(lines.filter((l) => / download .*\.mp4/.test(l))).toHaveLength(3);
    for (const l of lines) expect(l).not.toContain("--env"); // A3

    // cache: 3 clips, sha matches the runner's status and the file on disk
    expect(h.clips()).toBe(3);
    for (const j of s.jobs) {
      const paths = cachePaths(h.dir, j.key);
      const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
      expect(sha256File(paths.clip)).toBe(meta.video.sha256);
      expect(meta.job.output.sha256).toBe(meta.video.sha256);
      expect(meta.session).toBe(s.session);
      expect(existsSync(`${paths.clip}.part`)).toBe(false);
    }
    // cost facts are attached to every clip once the session is closed (run records are built from them)
    const costs = s.jobs.map((j) => JSON.parse(readFileSync(cachePaths(h.dir, j.key).meta, "utf8")).cost);
    for (const c of costs) expect(c).toMatchObject({ session: s.session, usageBeforeCU: 100, sessionActualCU: s.actualCU, stopped: true, sessionsVerifiedEmpty: true });
    expect(costs.reduce((sum, c) => sum + c.attributedCU, 0)).toBeCloseTo(s.actualCU!, 2); // attribution splits the session CU

    // ledger + session file
    const led = ledger(h);
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ session: s.session, outcome: "ok", stopVerified: true, jobs: 3, jobsOk: 3, gpu: "L4", budgetCU: 1 });
    expect(led[0]!.estimateCU).toBeCloseTo(rep.estimate.cu, 6);
    const usageAfter = (await new Colab({ env: h.env }).usage()).balance;
    expect(s.usageBeforeCU).toBe(100);
    expect(s.usageAfterCU).toBe(usageAfter);
    expect(s.actualCU).toBe(round2(100 - usageAfter));
    expect(usageAfter).toBe(fakeBalanceAfter(h));
    expect(s.actualCU!).toBeGreaterThan(0);
    const sf = JSON.parse(readFileSync(join(stateDir(h.dir), "sessions", `${s.session}.json`), "utf8"));
    expect(sf.status.phase).toBe("done");
    expect(sf.transcript.length).toBeGreaterThan(5);
    expect(sf.logs.runner).toContain("phase=done");
    expect(active(h)).toBeNull(); // CLOSE removed active.json
    expect(await h.sessions()).toEqual([]);
    expect(existsSync(join(stateDir(h.dir), "batch.lock"))).toBe(false);
    // step 8: `filmkit run <id>` per node (stand-in filmkit), without the spend authorization in its environment
    expect(rep.materialize.status).toBe("ok");
    expect(rep.materialize.nodes.map((n: { id: string; status: string }) => [n.id, n.status])).toEqual([["s1", "materialized"], ["s2", "materialized"], ["s3", "materialized"]]);
    expect(readFileSync(join(h.dir, "filmkit-run.log"), "utf8").trim().split("\n")).toEqual(["s1 yes=", "s2 yes=", "s3 yes="]);
  }, 90_000);

  test("L15 re-run after L1: nothing to generate, no colab call at all, 0 CU", async () => {
    const h = setup();
    expect((await h.run(h.batchArgs("--yes"))).exitCode).toBe(0);
    const before = readCalls(h.state).length;
    const r = await h.run(h.batchArgs("--yes", "--no-materialize"));
    expect(r.exitCode).toBe(0);
    expect(r.json.jobsToGenerate).toBe(0);
    expect(r.json.jobsCached).toBe(3);
    expect(r.json.session).toBeNull();
    expect(r.json.materialize).toEqual({ status: "skipped", reason: "--no-materialize", nodes: [] });
    expect(readCalls(h.state)).toHaveLength(before); // not even `version`
    expect(ledger(h)).toHaveLength(1);
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("L2 budget exceeded: exit 5 even with --yes, no colab call, breakdown in the JSON", async () => {
    const h = setup();
    const r = await h.run(h.batchArgs("--yes", "--budget", "0.3"));
    expect(r.exitCode).toBe(5);
    expect(r.json.ok).toBe(false);
    expect(r.json.gate.decision).toBe("needs-confirmation");
    expect(r.json.gate.reasons.map((x: any) => x.code)).toEqual(["over-budget"]);
    expect(r.json.estimate.jobs).toHaveLength(3);
    expect(h.calls()).toEqual([]); // no `new`, no `version`
    expect(existsSync(stateDir(h.dir))).toBe(false);
    expect(await h.sessions()).toEqual([]);
  });

  test("L3 batch of 3 without --yes: exit 5, no new; (with --yes it proceeds: see L1)", async () => {
    const h = setup();
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(5);
    expect(r.json.gate.reasons.map((x: any) => x.code)).toEqual(["batch-needs-yes"]);
    expect(h.calls().filter((x) => x === "new")).toEqual([]);
    expect(await h.sessions()).toEqual([]);
  });

  test("L4 setup/start failure (required node class missing): phase failed, stop+verify, exit 4, no cache entries", async () => {
    const h = setup({ nodes: 1, classes: [] });
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("failed");
    expect(s.jobsOk).toBe(0);
    expect(s.jobs[0]!.state).toBe("failed");
    expect(h.clips()).toBe(0);
    expect(s.stop.verified).toBe(true);
    expect(ledger(h)[0]).toMatchObject({ outcome: "failed", stopVerified: true });
    expect(h.calls().filter((x) => x === "stop")).toHaveLength(1);
    expect(await h.sessions()).toEqual([]);
    expect(active(h)).toBeNull();
  }, 60_000);

  test("L5 one job OOM: the other two are cached, exit 4, ledger partial, stop verified, no retry", async () => {
    const h = setup({ mode: ["ok", "oom", "ok"] });
    const r = await h.run(h.batchArgs("--yes"));
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("partial");
    expect(s.jobs.map((j) => j.state)).toEqual(["downloaded", "failed", "downloaded"]);
    expect(s.jobs[1]!.error).toContain("oom");
    expect(h.clips()).toBe(2);
    expect(ledger(h)[0]).toMatchObject({ outcome: "partial", jobs: 3, jobsOk: 2, stopVerified: true });
    expect(h.mock.prompts).toHaveLength(3); // generation is never retried
    expect(r.stderr).toContain("job s2#0: failed");
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("L6 hanging exec: the per-call timeout fires, the kernel is restarted, STOP runs, exit 4", async () => {
    const h = setup({ nodes: 1, env: { FAKE_COLAB_HANG: "exec", COLAB_COMFY_KICK_TIMEOUT_SEC: "1" } });
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("failed");
    expect(s.error).toContain("host timeout");
    const subs = h.calls();
    expect(subs).toContain("restart-kernel");
    expect(index(subs, "restart-kernel")).toBeLessThan(subs.lastIndexOf("stop"));
    expect(h.clips()).toBe(0);
    expect(await h.sessions()).toEqual([]);
  }, 60_000);

  test("L6b a poll that hangs once is a counted failure, not fatal: restart-kernel, next poll works, batch ok", async () => {
    const h = setup({ nodes: 1, env: { FAKE_COLAB_HANG: "exec:3", COLAB_COMFY_POLL_TIMEOUT_SEC: "1" } });
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(0);
    expect(h.calls()).toContain("restart-kernel");
    expect(h.clips()).toBe(1);
    expect(await h.sessions()).toEqual([]);
  }, 60_000);

  test("L7 preemption (session vanishes mid-run): 3 failed polls, finished clips kept, stop attempted, verify passes, ledger failed", async () => {
    const h = setup({ mode: ["ok", "ok", "hang"], env: { FAKE_COLAB_DROP: "after:7" } });
    const r = await h.run(h.batchArgs("--yes"));
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("failed");
    expect(s.abortReason).toBe("session-lost");
    expect(s.jobs.map((j) => j.state)).toEqual(["downloaded", "downloaded", "not-run"]);
    expect(h.clips()).toBe(2);
    expect(h.calls().filter((x) => x === "stop")).toHaveLength(1);
    expect(s.stop.verified).toBe(true);
    expect(ledger(h)[0]).toMatchObject({ outcome: "failed", abortReason: "session-lost", jobsOk: 2, stopVerified: true });
    expect(await h.sessions()).toEqual([]);
    expect(active(h)).toBeNull();
  }, 90_000);

  test("failed `new`: STOP still runs (and active.json was written BEFORE new); exit 4", async () => {
    const h = setup({ nodes: 1, env: { FAKE_COLAB_FAIL: "new" } });
    // spy shim in front of the fake: snapshot active.json at the moment `colab new` starts
    const spyDir = mkdtempSync(join(tmpdir(), "colab-comfy-spy-"));
    const snap = join(spyDir, "active-at-new.json");
    writeFileSync(
      join(spyDir, "colab"),
      `#!/bin/sh\ncase " $* " in *" new "*) cp "${activePath(stateDir(h.dir))}" "${snap}" 2>/dev/null;; esac\nexec "${join(import.meta.dir, "bin", "colab")}" "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const r = await h.run(h.batchArgs(), { PATH: `${spyDir}:${h.env.PATH}` });
      expect(r.exitCode).toBe(4);
      expect(existsSync(snap)).toBe(true);
      expect(JSON.parse(readFileSync(snap, "utf8"))).toMatchObject({ phase: "opening", pid: process.pid });
      const subs = h.calls();
      expect(subs.indexOf("stop")).toBeGreaterThan(subs.indexOf("new"));
      expect((r.json as BatchReport).session!.stop.verified).toBe(true);
      expect(await h.sessions()).toEqual([]);
      expect(active(h)).toBeNull();
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("download failures are retried 3x (cleanup, not generation), leave no .part and no cache entry, exit 4", async () => {
    const h = setup({ nodes: 1, env: { FAKE_COLAB_FAIL: "download" } });
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.jobs[0]!.state).toBe("download-failed");
    expect(h.callLines().filter((l) => / download .*\.mp4\.part/.test(l))).toHaveLength(3);
    expect(h.clips()).toBe(0);
    const cacheRoot = join(h.dir, ".colab-comfy", "cache");
    const leftovers = existsSync(cacheRoot) ? (Bun.spawnSync(["find", cacheRoot, "-name", "*.part"]).stdout.toString().trim()) : "";
    expect(leftovers).toBe("");
    expect(h.mock.prompts).toHaveLength(1);
    expect(await h.sessions()).toEqual([]);
  }, 60_000);

  test("L8 stop-always: 3 stop attempts, SESSION_LEAK, exit 4, active.json kept; then `reap` (stop fixed) cleans up", async () => {
    const h = setup({ nodes: 1, env: { FAKE_COLAB_FAIL: "stop-always" } });
    const run = h.spawn(h.batchArgs());
    const r = await run.done; // the helper process is gone afterwards: its pid is dead, so reap may take the session
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("SESSION_LEAK");
    const rep = JSON.parse(r.stdout) as BatchReport;
    expect(rep.session!.leak).toBe(true);
    expect(rep.session!.stop.verified).toBe(false);
    expect(rep.session!.stop.attempts).toBe(3);
    expect(h.calls().filter((x) => x === "stop").length).toBeGreaterThanOrEqual(3);
    expect(await h.sessions()).toHaveLength(1); // still alive
    expect(active(h)?.name).toBe(rep.session!.session); // retained for reap
    expect(h.clips()).toBe(1); // the work that did finish is kept

    const noFail = { FAKE_COLAB_FAIL: "" };
    const dry = await h.run(["reap", "--film", "./filmkit.yaml", "--json", "--dry-run"], noFail);
    expect(dry.exitCode).toBe(0);
    expect(dry.json.sessions.map((s: any) => s.action)).toEqual(["would-stop"]);
    expect(await h.sessions()).toHaveLength(1); // dry run touched nothing
    expect(active(h)).not.toBeNull();

    const reaped = await h.run(["reap", "--film", "./filmkit.yaml", "--json"], noFail);
    expect(reaped.exitCode).toBe(0);
    expect(reaped.json.sessions.map((s: any) => s.action)).toEqual(["stopped"]);
    expect(await h.sessions()).toEqual([]);
    expect(active(h)).toBeNull();
  }, 90_000);

  test("L9 SIGINT during POLL: salvage, stop, exit 130, ledger interrupted, sessions empty", async () => {
    const h = setup({ mode: ["ok", "hang", "hang"] });
    const run = h.spawn(h.batchArgs("--yes"));
    await waitFor(() => h.clips() >= 1, 60_000, "the first clip to be cached");
    run.proc.kill("SIGINT");
    const r = await run.done;
    expect(r.code).toBe(130);
    const rep = JSON.parse(r.stdout) as BatchReport;
    expect(rep.session!.outcome).toBe("interrupted");
    expect(rep.session!.signal).toBe("SIGINT");
    expect(rep.session!.stop.verified).toBe(true);
    expect(h.clips()).toBe(1);
    const subs = h.calls();
    expect(subs.filter((x) => x === "stop")).toHaveLength(1);
    expect(ledger(h)[0]).toMatchObject({ outcome: "interrupted", stopVerified: true });
    expect(await h.sessions()).toEqual([]);
    expect(active(h)).toBeNull();
  }, 90_000);

  test("L10 SIGTERM during POLL: same, exit 143", async () => {
    const h = setup({ mode: ["ok", "hang", "hang"] });
    const run = h.spawn(h.batchArgs("--yes"));
    await waitFor(() => h.clips() >= 1, 60_000, "the first clip to be cached");
    run.proc.kill("SIGTERM");
    const r = await run.done;
    expect(r.code).toBe(143);
    expect(JSON.parse(r.stdout).session.outcome).toBe("interrupted");
    expect(ledger(h)[0]).toMatchObject({ outcome: "interrupted", stopVerified: true });
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("SIGINT while `new` is still pending: the client is killed, STOP runs, exit 130 (no salvage phase)", async () => {
    // hang the 1st `exec` is too late; use a real slow `new`: the spy shim sleeps before delegating
    const h = setup({ nodes: 1 });
    const slowDir = mkdtempSync(join(tmpdir(), "colab-comfy-slow-"));
    writeFileSync(join(slowDir, "colab"), `#!/bin/sh\ncase " $* " in *" new "*) exec sleep 30;; esac\nexec "${join(import.meta.dir, "bin", "colab")}" "$@"\n`, { mode: 0o755 });
    try {
      const run = h.spawn(h.batchArgs(), { PATH: `${slowDir}:${h.env.PATH}` });
      await waitFor(() => readActive(stateDir(h.dir))?.phase === "opening", 30_000, "active.json (opening)");
      await sleep(500); // `colab new` is now running (sleeping)
      const t0 = Date.now();
      run.proc.kill("SIGINT");
      const r = await run.done;
      expect(r.code).toBe(130);
      expect(Date.now() - t0).toBeLessThan(20_000); // did not wait for the 30 s `new`
      expect(JSON.parse(r.stdout).session.outcome).toBe("interrupted");
      expect(h.calls()).toContain("stop");
      expect(await h.sessions()).toEqual([]);
    } finally {
      rmSync(slowDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("third SIGINT exits at once with a loud warning (the session may leak; guard/reap are the net)", async () => {
    const h = setup({ nodes: 1, mode: "hang", env: { FAKE_COLAB_FAIL: "stop-always", COLAB_COMFY_BACKOFF_MS: "60000" } });
    const run = h.spawn(h.batchArgs());
    await waitFor(() => readActive(stateDir(h.dir))?.phase === "running", 60_000, "the poll phase");
    run.proc.kill("SIGINT"); // 1: salvage then stop -> stop fails, helper sleeps in backoff
    await waitFor(() => h.calls().includes("stop"), 30_000, "the first stop attempt");
    run.proc.kill("SIGINT"); // 2: (already stopping)
    await sleep(100);
    run.proc.kill("SIGINT"); // 3: exit
    const r = await run.done;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("SESSION MAY LEAK: run colab-comfy reap");
    expect(await h.sessions()).toHaveLength(1);
    // cleanup of the intentionally leaked session (cleanup() also kills the guard)
    const rec = readActive(stateDir(h.dir));
    if (rec?.guardPid) process.kill(rec.guardPid, "SIGKILL");
    await new Colab({ env: { ...h.env, FAKE_COLAB_FAIL: "" } }).stop(rec!.name);
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("uncaughtException during the run takes the stop path (ledger interrupted, exit 4, sessions empty)", async () => {
    const h = setup({ nodes: 1, mode: "hang" });
    const run = h.run(h.batchArgs());
    await waitFor(() => readActive(stateDir(h.dir))?.phase === "running", 60_000, "the poll phase");
    // call OUR listener (the last one registered) directly: bun's test runner has its own
    const ours = process.listeners("uncaughtException").at(-1)!;
    (ours as (e: Error) => void)(new Error("boom from a timer callback"));
    const r = await run;
    expect(r.exitCode).toBe(4);
    expect(r.json.session.outcome).toBe("interrupted");
    expect(r.json.session.error).toContain("boom");
    expect(r.json.session.stop.verified).toBe(true);
    expect(await h.sessions()).toEqual([]);
    expect(process.listeners("uncaughtException").includes(ours)).toBe(false); // handlers removed afterwards
  }, 90_000);

  test("L11 SIGKILL of the helper: the detached guard stops the session within 2 ticks (+ call latency)", async () => {
    const h = setup({ nodes: 1, mode: "hang" });
    const run = h.spawn(h.batchArgs());
    await waitFor(() => readActive(stateDir(h.dir))?.phase === "running" && readActive(stateDir(h.dir))?.guardPid !== undefined, 60_000, "poll phase + guard");
    expect(await h.sessions()).toHaveLength(1);
    const guardPid = readActive(stateDir(h.dir))!.guardPid!;
    expect(pidAlive(guardPid)).toBe(true);
    run.proc.kill("SIGKILL");
    await run.done;
    await waitFor(async () => (await h.sessions()).length === 0, 20_000, "the guard to stop the session");
    await waitFor(() => active(h) === null, 10_000, "the guard to clear active.json");
    expect(ledger(h).at(-1)).toMatchObject({ outcome: "guard-stopped", guardReason: "parent-dead", stopVerified: true });
    await waitFor(() => !pidAlive(guardPid), 10_000, "the guard to exit");
  }, 90_000);

  test("guard exits by itself when active.json is gone (normal CLOSE)", async () => {
    const h = setup({ nodes: 1 });
    const r = await h.run(h.batchArgs("--session", "fk-guard-exit-check"));
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(stateDir(h.dir), "guard-fk-guard-exit-check.log"))).toBe(true);
    // the guard's parent (this test process) is still alive: it must nevertheless be gone shortly after CLOSE
    await waitFor(() => Bun.spawnSync(["pgrep", "-f", "guard --session fk-guard-exit-check"]).stdout.toString().trim() === "", 10_000, "the guard to exit");
  }, 60_000);

  test("L12 foreign session active: exit 3, no `new`, the foreign session is untouched (also an unrecorded fk-* one)", async () => {
    const h = setup({ nodes: 1 });
    const colab = new Colab({ env: h.env });
    expect((await colab.newSession("someone-elses-notebook")).ok).toBe(true);
    const r = await h.run(h.batchArgs());
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("someone-elses-notebook");
    expect(h.calls().filter((x) => x === "new")).toHaveLength(1); // the test's own
    expect(h.calls()).not.toContain("stop");
    expect(await h.sessions()).toEqual(["someone-elses-notebook"]);

    expect((await colab.newSession("fk-other-project-202601010000")).ok).toBe(true); // fk-* but not ours (no record)
    const r2 = await h.run(h.batchArgs());
    expect(r2.exitCode).toBe(3);
    expect(h.calls()).not.toContain("stop");
    expect(await h.sessions()).toEqual(["fk-other-project-202601010000", "someone-elses-notebook"]);
    await colab.stop("someone-elses-notebook");
    await colab.stop("fk-other-project-202601010000");
    expect(await h.sessions()).toEqual([]);
    expect(active(h)).toBeNull();
  }, 60_000);

  test("L13 deadline reached (tiny --max-wall): salvage, stop, aborted-deadline, exit 4", async () => {
    const h = setup({ mode: ["ok", "hang", "hang"] });
    const r = await h.run(h.batchArgs("--yes", "--max-wall", "12"));
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("aborted-deadline");
    expect(s.abortReason).toBe("deadline");
    expect(s.jobs.map((j) => j.state)).toEqual(["downloaded", "not-run", "not-run"]);
    expect(h.clips()).toBe(1);
    expect(s.stop.verified).toBe(true);
    expect(ledger(h)[0]).toMatchObject({ outcome: "aborted-deadline", stopVerified: true });
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("budget exhausted at runtime (usage sample): salvage, stop, aborted-deadline/budget", async () => {
    const h = setup({ nodes: 2, mode: ["ok", "hang"], env: { FAKE_COLAB_CU_PER_SEC: "0.5", COLAB_COMFY_USAGE_SEC: "0.3" } });
    const r = await h.run(h.batchArgs("--yes", "--budget", "1"));
    expect(r.exitCode).toBe(4);
    const s = (r.json as BatchReport).session!;
    expect(s.outcome).toBe("aborted-deadline");
    expect(s.abortReason).toBe("budget");
    expect(s.stop.verified).toBe(true);
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("L14b VM releases itself (watchdog -> release.request): host salvages what finished, STOP + VERIFY, outcome failed", async () => {
    const h = setup({ mode: ["ok", "hang", "hang"] });
    const run = h.run(h.batchArgs("--yes"));
    await waitFor(() => h.clips() >= 1, 60_000, "the first clip");
    const sess = readdirSync(join(h.state, "sessions"))[0]!;
    writeFileSync(join(h.state, "sessions", sess, "content", "fk", "release.request"), "{}");
    const r = await run;
    expect(r.exitCode).toBe(4);
    expect(r.json.session.abortReason).toBe("vm-released");
    expect(r.json.session.stop.verified).toBe(true);
    expect(h.clips()).toBe(1);
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("runner process dies mid-run: detected (runnerAlive false twice / stale heartbeat), STOP, exit 4", async () => {
    const h = setup({ nodes: 1, mode: "hang" });
    const run = h.run(h.batchArgs());
    await waitFor(() => readActive(stateDir(h.dir))?.phase === "running", 60_000, "the poll phase");
    const sess = readdirSync(join(h.state, "sessions"))[0]!;
    const pidFile = join(h.state, "sessions", sess, "content", "fk", "runner.pid");
    await waitFor(() => existsSync(pidFile), 10_000, "runner.pid");
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    const r = await run;
    expect(r.exitCode).toBe(4);
    expect(r.json.session.abortReason).toBe("vm-stale");
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("batch.lock: a second batch in the same project is refused while the first runs", async () => {
    const h = setup({ nodes: 1, mode: "hang" });
    const first = h.spawn(h.batchArgs());
    await waitFor(() => readActive(stateDir(h.dir))?.phase === "running", 60_000, "the poll phase");
    const second = await h.run(h.batchArgs());
    expect(second.exitCode).toBe(4);
    expect(second.stderr).toContain("another colab-comfy batch is running");
    first.proc.kill("SIGINT");
    expect((await first.done).code).toBe(130);
    expect(await h.sessions()).toEqual([]);
  }, 90_000);

  test("--session override must start with fk- (reap's safety rule); a valid one is used", async () => {
    const h = setup({ nodes: 1 });
    const bad = await h.run(h.batchArgs("--session", "mine"));
    expect(bad.exitCode).toBe(2);
    expect(h.calls()).toEqual([]);
    const ok = await h.run(h.batchArgs("--session", "fk-custom-name"));
    expect(ok.exitCode).toBe(0);
    expect(ok.json.session.session).toBe("fk-custom-name");
    expect(h.callLines().some((l) => l.includes("new -s fk-custom-name"))).toBe(true);
    expect(await h.sessions()).toEqual([]);
  }, 60_000);

  test("reap: stops only OUR leaked session (recorded, owner dead); foreign and unrecorded fk-* stay; stale active.json is cleared", async () => {
    const h = setup({ nodes: 1 });
    const colab = new Colab({ env: h.env });
    await colab.newSession("fk-ours-202601010000");
    await colab.newSession("fk-not-recorded-202601010000");
    await colab.newSession("their-notebook");
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeActive(stateDir(h.dir), { name: "fk-ours-202601010000", pid: dead.pid, deadline: 0, phase: "running", film: "f", startedAt: "t" });

    const r = await h.run(["reap", "--film", "./filmkit.yaml", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.json.sessions.map((s: any) => [s.name, s.action])).toEqual([
      ["fk-not-recorded-202601010000", "foreign"],
      ["fk-ours-202601010000", "stopped"],
      ["their-notebook", "foreign"],
    ]);
    expect(await h.sessions()).toEqual(["fk-not-recorded-202601010000", "their-notebook"]);
    expect(active(h)).toBeNull();
    expect(h.callLines().filter((l) => l.includes(" stop "))).toEqual(["--auth adc stop -s fk-ours-202601010000"]);

    // a live owner protects its session; a record whose session is gone and owner dead is cleared
    writeActive(stateDir(h.dir), { name: "fk-not-recorded-202601010000", pid: process.pid, deadline: 0, phase: "running", film: "f", startedAt: "t" });
    const live = await h.run(["reap", "--film", "./filmkit.yaml", "--json"]);
    expect(live.json.sessions.find((s: any) => s.name === "fk-not-recorded-202601010000").action).toBe("running");
    writeActive(stateDir(h.dir), { name: "fk-gone-202601010000", pid: dead.pid, deadline: 0, phase: "running", film: "f", startedAt: "t" });
    const stale = await h.run(["reap", "--film", "./filmkit.yaml", "--json"]);
    expect(stale.json.activeCleared).toBe(true);
    expect(active(h)).toBeNull();

    await colab.stop("fk-not-recorded-202601010000");
    await colab.stop("their-notebook");
    expect(await h.sessions()).toEqual([]);
    const nothing = await h.run(["reap", "--film", "./filmkit.yaml"]);
    expect(nothing.stdout).toContain("nothing to reap");
  }, 60_000);

  test("guard: without --state etc. it is refused with exit 2 (internal command, explicit errors)", async () => {
    const h = setup({ nodes: 1 });
    const r = await h.run(["guard", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--session is required");
  });
});
