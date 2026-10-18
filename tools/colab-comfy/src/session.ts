// Session lifecycle (PLAN §6.4 + M0 amendments A1-A12):
//
//   PRECHECK  version; sessions (our dead leftovers are reaped, a foreign/live session -> exit 3, never touched); usage
//   OPEN      active.json BEFORE `new`; detached guard; `new` (returns after READY, A6); one `status` sanity call
//   UPLOAD    exec fk_mkdirs.py (A4: the remote dir must exist), then upload the bundle to /content/fk/bundle.tar.gz
//   KICK      exec fk_kick.py (extract + start the runner)
//   POLL      every COLAB_COMFY_POLL_SEC: exec fk_poll.py -> FKSTATUS; each newly done job is downloaded at once
//   COLLECT   runner/setup/comfy logs, bounded, redacted
//   STOP      `colab stop`: in `finally`, also after a failed `new` or any earlier failure
//   VERIFY    `colab sessions` no longer lists NAME (A7); 3 attempts; else SESSION_LEAK (exit 4, active.json kept)
//   USAGE     usage before/after -> actualCU
//   CLOSE     ledger + sessions/<name>.json; active.json removed (only when verified); the guard sees it gone and exits
//
// Rules:
//  * Generation is never retried. Downloads and stop/verify are cleanup/salvage and are retried (bounded).
//  * Everything that talks to `colab` is async with a timeout (src/colab.ts); signal handlers can therefore run.
//  * Signals (SIGINT/SIGTERM/SIGHUP): 1st = salvage (<= COLAB_COMFY_SALVAGE_SEC) then stop; 2nd = stop now;
//    3rd = print a warning and exit. uncaughtException/unhandledRejection take the first-signal path.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectedNode } from "./batch.ts";
import { buildJobsDoc, VM_DIR, writeBundle, type JobsDoc } from "./bundle.ts";
import { attachCost, cachePaths, writeFileAtomic } from "./cache.ts";
import { sha256File } from "./canonical.ts";
import { Colab, isReleasing, type CallLogEntry, type ColabOptions, type UsageInfo } from "./colab.ts";
import { cuFor } from "./estimate.ts";
import { ColabComfyError, EXIT } from "./errors.ts";
import { spawnGuard } from "./guard.ts";
import { appendLedger, removeActive, stateDir, writeActive, writeSessionFile, type ActiveRecord } from "./ledger.ts";
import { redact } from "./redact.ts";
import { reap } from "./reap.ts";
import { backoffFromEnv, sleep, stopAndVerify, type StopOutcome } from "./teardown.ts";

export const REMOTE_ROOT = "/content/fk";
/** The VM hard deadline (watchdog self-release) is this long after the host deadline; the guard fires at +300 s. */
const VM_DEADLINE_AFTER_HOST_SEC = 180;

export type Outcome = "ok" | "partial" | "failed" | "interrupted" | "aborted-deadline";
export type AbortReason = "signal" | "fatal" | "deadline" | "budget" | "session-lost" | "vm-stale" | "vm-released" | "error";

export interface SessionOptions {
  /** Film directory; state lives in <baseDir>/.colab-comfy. */
  baseDir: string;
  name: string;
  /** Film path as given by the user (for the ledger). */
  film: string;
  filmSha256?: string;
  gpu: string;
  budgetCU: number;
  estimateCU: number;
  rateCuPerHour: number;
  /** Estimated billed seconds and margin: re-checked against the rate `colab usage` reports after `new`. */
  estimateTotalSec?: number;
  margin?: number;
  /** As the user asked (`auto`, `L4`, ...); default = gpu. */
  gpuRequested?: string;
  /**
   * `--gpu auto` only: opened instead when `colab new` cannot get `gpu` (e.g. A100 unavailable). Only set when its
   * estimate fits the budget. Still exactly one session: the failed request is verified absent first.
   */
  fallback?: { gpu: string; estimateCU: number; rateCuPerHour: number; totalSec: number } | null;
  maxWallSec?: number;
  /** Nodes with at least one uncached candidate. */
  nodes: SelectedNode[];
  env: Record<string, string | undefined>;
  colabOptions?: ColabOptions;
  /** Progress lines (stderr in the CLI). */
  log?: (line: string) => void;
  /** Default true. Process-wide signal/exception handlers are installed for the duration of the session. */
  installHandlers?: boolean;
  /** Default true. */
  guard?: boolean;
}

export interface JobResult {
  key: string;
  node: string;
  candidate: number;
  state: "downloaded" | "failed" | "download-failed" | "not-run";
  error?: string;
  cachePath?: string;
  wallSec?: number;
  peakVramMiB?: number;
}

export interface SessionResult {
  session: string;
  outcome: Outcome;
  exitCode: number;
  abortReason?: AbortReason;
  /** e.g. SIGINT, when interrupted by a signal. */
  signal?: string;
  error?: string;
  jobs: JobResult[];
  jobsTotal: number;
  jobsOk: number;
  usageBeforeCU: number;
  usageAfterCU: number | null;
  actualCU: number | null;
  /**
   * The balance settled after the stop (two consecutive equal `colab usage` readings). false = the settle timeout
   * (or an interrupt) came first: usageAfterCU/actualCU are PROVISIONAL and probably too low (billing lags).
   */
  usageSettled: boolean;
  /** GPU actually opened (after a fallback, the fallback GPU). */
  gpu: string;
  gpuRequested: string;
  gpuFallback?: { from: string; to: string; reason: string };
  /** `Usage rate` reported right after `new` (null when it read 0 or failed). */
  rateObservedCuPerHour: number | null;
  /** Estimate for the GPU actually opened. */
  estimateCU: number;
  stop: StopOutcome;
  /** SESSION_LEAK: the session is still listed after all stop attempts. */
  leak: boolean;
  /** Reported, not fatal (e.g. usage still shows an assignment although the session is gone). */
  warnings: string[];
  startedAt: string;
  endedAt: string;
  ledgerPath: string;
}

const SIGNO: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

const envNum = (env: Record<string, string | undefined>, key: string, fallback: number): number => {
  const v = env[key];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * `fk-<film name>-<UTC yyyymmddHHMM>`, lowercased, <= 40 chars. Decision: when it is too long the NAME part is
 * cut, never the timestamp, so two runs of the same film still get different session names.
 */
export function sessionName(filmName: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const room = 40 - "fk-".length - 1 - ts.length;
  const slug = filmName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, room).replace(/-+$/g, "") || "film";
  return `fk-${slug}-${ts}`;
}

/**
 * Wall-clock cap (PLAN §6.3): min(--max-wall, budget/rate) minus a teardown reserve. The reserve is 120 s, or half
 * of a tiny wall (decision: a literal 120 s would put the deadline in the past for the short walls tests use).
 */
export function computeDeadlineMs(startMs: number, o: { budgetCU: number; rateCuPerHour: number; maxWallSec?: number }): number {
  const wall = Math.min(o.maxWallSec ?? Infinity, (o.budgetCU / o.rateCuPerHour) * 3600);
  return startMs + (wall - Math.min(120, wall / 2)) * 1000;
}

/** Control-flow exception that unwinds the lifecycle to the teardown; it is never shown as a stack trace. */
class Unwind extends Error {
  constructor(
    readonly reason: AbortReason,
    message: string,
    readonly exitCode: number = EXIT.toolFailure,
  ) {
    super(message);
  }
}

/** Mutable flags shared by the signal handlers and the lifecycle. */
class Control {
  signals = 0;
  signal?: string;
  fatal?: string;
  skipSalvage = false;
  phase: "open" | "poll" | "collect" | "stopping" = "open";
  private readonly wakers = new Set<() => void>();
  get stopRequested(): boolean {
    return this.signals > 0 || this.fatal !== undefined;
  }
  wake(): void {
    for (const w of [...this.wakers]) w();
  }
  /** Sleep that ends early when a stop is requested. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
      if (this.stopRequested) done();
    });
  }
}

function installHandlers(ctl: Control, colab: Colab, log: (m: string) => void, salvageSec: number): () => void {
  const onSignal = (sig: NodeJS.Signals) => {
    ctl.signals++;
    if (ctl.signals === 1) {
      ctl.signal = sig;
      ctl.skipSalvage = ctl.phase !== "poll";
      log(`${sig}: ${ctl.skipSalvage ? "stopping the session" : `salvaging finished clips (<= ${salvageSec}s), then stopping`}`);
      if (ctl.phase === "open") colab.abortInFlight(); // a pending `new`/upload/kick must not delay STOP
    } else if (ctl.signals === 2) {
      log(`${sig}: second signal, stopping now`);
      ctl.skipSalvage = true;
      if (ctl.phase !== "stopping") colab.abortInFlight();
    } else {
      process.stderr.write("SESSION MAY LEAK: run colab-comfy reap\n");
      process.exit(128 + (SIGNO[sig] ?? 1));
    }
    ctl.wake();
  };
  const onFatal = (err: unknown) => {
    const text = redact(err instanceof Error ? (err.stack ?? err.message) : String(err));
    log(`fatal: ${text.split("\n")[0]}`);
    ctl.fatal ??= text;
    ctl.skipSalvage = ctl.phase !== "poll";
    if (ctl.phase !== "stopping") colab.abortInFlight();
    ctl.wake();
  };
  const sigHandlers = (Object.keys(SIGNO) as NodeJS.Signals[]).map((s) => [s, () => onSignal(s)] as const);
  for (const [s, h] of sigHandlers) process.on(s, h);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  return () => {
    for (const [s, h] of sigHandlers) process.off(s, h);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  };
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s);
const tail = (s: string, lines: number, maxChars: number): string => clip(s.split("\n").slice(-lines).join("\n"), maxChars);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Heuristic: an auth/credential failure of `new` is a missing dependency (exit 3), anything else a tool failure (4). */
function newFailureExit(text: string): number {
  return /unauthenticated|not authenticated|credential|login|\b401\b|\b403\b|permission denied/i.test(text) ? EXIT.missingDependency : EXIT.toolFailure;
}

interface FkJob {
  key: string;
  state?: string;
  wallSec?: number | null;
  peakVramMiB?: number | null;
  output?: { path?: string; bytes?: number; sha256?: string } | null;
  error?: { kind?: string; message?: string } | null;
}
interface FkStatus {
  phase?: string;
  jobs?: FkJob[];
  env?: unknown;
  heartbeatAt?: number;
  error?: unknown;
  ok?: boolean;
  runnerAlive?: boolean;
  setup?: { startedAt?: number; finishedAt?: number };
  [k: string]: unknown;
}

const TERMINAL_PHASES = new Set(["done", "failed", "aborted"]);

export async function runSession(o: SessionOptions): Promise<SessionResult> {
  const env = o.env;
  const log = o.log ?? (() => {});
  const dir = stateDir(o.baseDir);
  const pollSec = envNum(env, "COLAB_COMFY_POLL_SEC", 20);
  const kickTimeoutSec = envNum(env, "COLAB_COMFY_KICK_TIMEOUT_SEC", 120);
  const pollTimeoutSec = envNum(env, "COLAB_COMFY_POLL_TIMEOUT_SEC", 60);
  const salvageSec = envNum(env, "COLAB_COMFY_SALVAGE_SEC", 60);
  const collectSec = envNum(env, "COLAB_COMFY_COLLECT_SEC", 60);
  const usageEverySec = envNum(env, "COLAB_COMFY_USAGE_SEC", 300);
  const staleSec = envNum(env, "COLAB_COMFY_HEARTBEAT_STALE_SEC", 180);
  const settleIntervalSec = envNum(env, "COLAB_COMFY_SETTLE_INTERVAL_SEC", 30);
  const settleTimeoutSec = envNum(env, "COLAB_COMFY_SETTLE_TIMEOUT_SEC", 210);
  const backoff = backoffFromEnv(env);

  const transcript: { args: string[]; code: number | null; timedOut: boolean; ms: number; stdout: string; stderr: string }[] = [];
  const colab = new Colab({
    ...o.colabOptions,
    env,
    onCall: (e: CallLogEntry) => {
      // exec stdout carries the whole status.json every poll: keep the transcript small (newest 600 calls).
      transcript.push({ args: e.args, code: e.code, timedOut: e.timedOut, ms: e.ms, stdout: clip(e.stdout, 2000), stderr: clip(e.stderr, 2000) });
      if (transcript.length > 600) transcript.shift();
      o.colabOptions?.onCall?.(e);
    },
  });

  // ---------------- PRECHECK (nothing is spent; failures here need no STOP) ----------------
  await colab.version();
  const swept = await reap({ stateDir: dir, colab, backoffMs: backoff, log });
  if (!swept.ok) {
    throw new ColabComfyError(EXIT.toolFailure, [
      { code: "SESSION_LEAK", message: `could not release leftover session(s) ${swept.leaked.join(", ")}`, hint: "stop them with `colab stop -s <name>`, then re-run" },
    ]);
  }
  const blockers = swept.sessions.filter((s) => s.action === "foreign" || s.action === "running");
  if (blockers.length) {
    throw new ColabComfyError(EXIT.missingDependency, [
      {
        code: "foreign-session",
        message: `colab already has an active session: ${blockers.map((b) => `${b.name} (${b.reason})`).join("; ")}`,
        hint: "this tool never touches sessions it does not own; stop it yourself (or finish the other batch) and re-run",
      },
    ]);
  }
  const usageBefore = await colab.usage();

  const startedMs = Date.now();
  // Mutable: a GPU fallback or the rate `colab usage` reports after `new` recompute it (active.json carries it to the guard).
  let gpu = o.gpu;
  let rateCuPerHour = o.rateCuPerHour;
  let estimateCU = o.estimateCU;
  let estimateTotalSec = o.estimateTotalSec;
  let rateObserved: number | null = null;
  /** When the `colab new` that succeeded was issued (billing starts there); null = no session was opened. */
  let billedFromMs: number | null = null;
  let gpuFallback: SessionResult["gpuFallback"];
  let deadlineMs = computeDeadlineMs(startedMs, o);
  // Built before OPEN: a bad input (e.g. key mismatch) must fail while nothing is running.
  const buildFor = (deadline: number) =>
    buildJobsDoc({ session: o.name, nodes: o.nodes, baseDir: o.baseDir, limits: { hardDeadlineEpoch: Math.floor(deadline / 1000) + VM_DEADLINE_AFTER_HOST_SEC } });
  let built = buildFor(deadlineMs);
  const doc: JobsDoc = built.doc;
  const work = mkdtempSync(join(tmpdir(), "colab-comfy-session-"));
  const bundle = join(work, "bundle.tar.gz");
  const secretsEnv = env.HF_TOKEN ? `HF_TOKEN=${env.HF_TOKEN}\n` : undefined;
  try {
    await writeBundle({ built, outFile: bundle, secretsEnv });
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw err;
  }

  // ---------------- from here on a session may exist: everything ends in STOP ----------------
  const ctl = new Control();
  const uninstall = o.installHandlers === false ? () => {} : installHandlers(ctl, colab, log, salvageSec);
  const startedAt = new Date(startedMs).toISOString();
  const active: ActiveRecord = { name: o.name, pid: process.pid, deadline: deadlineMs / 1000, phase: "opening", film: o.film, startedAt };
  const setActivePhase = (phase: ActiveRecord["phase"]) => {
    active.phase = phase;
    writeActive(dir, active);
  };

  const jobs = new Map<string, JobResult>();
  for (const j of doc.jobs) jobs.set(j.key, { key: j.key, node: j.node, candidate: j.candidate, state: "not-run" });
  const attempts = new Map<string, number>();
  let lastStatus: FkStatus | null = null;
  let logs: Record<string, string> = {};
  let unwind: Unwind | null = null;
  let unexpected = false;
  let phaseNormal = false; // the runner reached phase `done`
  const timing = { newSec: 0, teardownSec: 0 };

  const abortIfRequested = (): void => {
    if (ctl.fatal !== undefined) throw new Unwind("fatal", `unexpected error: ${ctl.fatal.split("\n")[0]}`);
    if (ctl.signals > 0) throw new Unwind("signal", `interrupted by ${ctl.signal}`);
  };

  /** One download attempt of a finished job into the cache; throws a short reason on failure. */
  const downloadOnce = async (j: FkJob, idx: number): Promise<void> => {
    const out = j.output;
    if (typeof out?.bytes !== "number" || !out.sha256) throw new Error("status has no complete output record");
    const paths = cachePaths(o.baseDir, j.key);
    const part = `${paths.clip}.part`;
    mkdirSync(paths.dir, { recursive: true });
    try {
      // Protocol path (PLAN §5.5: out/<key>.mp4), not status.output.path: the host does not take download paths from the VM.
      const r = await colab.download(o.name, `${REMOTE_ROOT}/out/${j.key}.mp4`, part);
      if (!r.ok) throw new Error(`colab download ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${tail(r.stderr || r.stdout, 3, 300)}`);
      const size = statSync(part).size;
      if (size !== out.bytes) throw new Error(`size mismatch: got ${size}, expected ${out.bytes}`);
      const sha = sha256File(part);
      if (sha !== out.sha256) throw new Error(`sha256 mismatch: got ${sha}`);
      // meta first, then the clip: the cache counts a hit only when both exist (src/cache.ts).
      const info = doc.jobs[idx]!;
      writeFileAtomic(
        paths.meta,
        JSON.stringify(
          {
            key: j.key,
            node: info.node,
            candidate: info.candidate,
            seed: info.seed,
            session: o.name,
            downloadedAt: new Date().toISOString(),
            job: j,
            env: lastStatus?.env ?? null,
            video: { sha256: sha, bytes: size },
          },
          null,
          2,
        ) + "\n",
      );
      renameSync(part, paths.clip);
    } finally {
      rmSync(part, { force: true });
    }
  };

  /** Bounded retry (cleanup/salvage, never generation). `tries` = 1 when the VM is going away anyway. */
  const downloadJob = async (j: FkJob, tries: number): Promise<void> => {
    const idx = doc.jobs.findIndex((x) => x.key === j.key);
    const res = jobs.get(j.key);
    if (idx < 0 || !res) return;
    let lastErr = "";
    for (let i = 1; i <= tries; i++) {
      attempts.set(j.key, (attempts.get(j.key) ?? 0) + 1);
      try {
        await downloadOnce(j, idx);
        res.state = "downloaded";
        res.cachePath = cachePaths(o.baseDir, j.key).clip;
        res.wallSec = j.wallSec ?? undefined;
        res.peakVramMiB = j.peakVramMiB ?? undefined;
        log(`downloaded ${res.node}#${res.candidate} -> cache`);
        return;
      } catch (err) {
        lastErr = redact((err as Error).message);
        if (i < tries && !ctl.skipSalvage) await sleep(backoff[Math.min(i - 1, backoff.length - 1)] ?? 0);
      }
    }
    res.state = "download-failed";
    res.error = lastErr;
    log(`download of ${res.node}#${res.candidate} failed: ${lastErr}`);
  };

  /** Fold a status into `jobs`, downloading every newly done clip at once. */
  const absorb = async (st: FkStatus, tries: number): Promise<void> => {
    lastStatus = st;
    for (const j of st.jobs ?? []) {
      const res = jobs.get(j.key);
      if (!res) continue;
      if (j.state === "done" && res.state === "not-run" && (attempts.get(j.key) ?? 0) === 0) {
        await downloadJob(j, tries);
      } else if (j.state === "failed" && res.state === "not-run") {
        res.state = "failed";
        res.error = redact(`${j.error?.kind ?? "failed"}: ${j.error?.message ?? ""}`.trim());
        res.wallSec = j.wallSec ?? undefined;
        res.peakVramMiB = j.peakVramMiB ?? undefined;
      }
    }
  };

  const execStatus = (script: string, timeoutSec: number) => colab.exec(o.name, join(VM_DIR, script), timeoutSec);
  const execOk = (what: string, r: Awaited<ReturnType<typeof execStatus>>): void => {
    if (r.fkstatus?.ok === true) return;
    const why = r.timedOut
      ? "host timeout"
      : r.sessionNotFound
        ? "session not found"
        : r.fkstatus
          ? String(r.fkstatus.error ?? "not ok")
          : `no FKSTATUS line: ${tail(r.stderr || r.stdout, 4, 400)}`;
    throw new Unwind("error", `${what} failed: ${why}`);
  };

  let kickedAtMs = Date.now();
  /** Parsed status; null = a failed poll (counted by the caller). */
  const pollOnce = async (): Promise<(FkStatus & { pending?: boolean }) | null> => {
    const r = await execStatus("fk_poll.py", pollTimeoutSec);
    const fk = r.fkstatus as FkStatus | null;
    if (!fk) return null;
    if (fk.ok === false) {
      // status.json is written by the runner a moment after the kick: not a failure during the first minute.
      if (/not written yet/.test(String(fk.error)) && Date.now() - kickedAtMs < 60_000) return { phase: "setup", jobs: [], pending: true };
      return null;
    }
    return fk;
  };

  /** One last poll + downloads, bounded; run before stopping an aborted session. Never throws. */
  const salvage = async (): Promise<void> => {
    if (ctl.skipSalvage || salvageSec <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const st = await pollOnce();
          if (st && !st.pending) await absorb(st, 1);
        })(),
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            colab.abortInFlight();
            r();
          }, salvageSec * 1000);
        }),
      ]);
    } catch (err) {
      log(`salvage failed: ${redact((err as Error).message)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let result!: SessionResult;

  /** STOP -> VERIFY -> USAGE -> CLOSE. Called from `finally`; every step is guarded so none can skip the next. */
  const finish = async (): Promise<void> => {
    ctl.phase = "stopping";
    const tTear = Date.now();
    try {
      setActivePhase("stopping");
    } catch {
      // active.json is only a hint for guard/reap; stopping matters more
    }
    const stop = await stopAndVerify(colab, o.name, backoff, log);
    const leak = !stop.verified;
    const warnings: string[] = leak ? [...stop.notes] : [];

    // Billing lags the stop (M8 A100: 0.16 CU right after the stop, 0.60 CU settled a few seconds later), so the
    // balance is polled until two consecutive readings agree. A timeout or an interrupt records it as provisional.
    // A stale balance can also read the same twice, so equal readings only count once the spend is plausible:
    // at least half of rate x session lifetime (billing never charged less than that in M8/A100).
    const stoppedMs = Date.now();
    const settleRate = rateObserved ?? rateCuPerHour;
    const plausibleCU = billedFromMs === null ? 0 : 0.5 * settleRate * ((stoppedMs - billedFromMs) / 3_600_000);
    let usageAfterCU: number | null = null;
    let usageSettled = false;
    let lastUsage: UsageInfo | null = null;
    const interrupted = () => ctl.signals > 0 || ctl.fatal !== undefined;
    const settleStart = Date.now();
    for (;;) {
      try {
        const u = await colab.usage();
        if (lastUsage !== null && u.balance === lastUsage.balance && round2(usageBefore.balance - u.balance) >= round2(plausibleCU) - 0.01) usageSettled = true;
        lastUsage = u;
        usageAfterCU = u.balance;
      } catch (err) {
        warnings.push(`usage after the run unavailable: ${(err as Error).message.split("\n")[0]}`);
      }
      if (usageSettled || !stop.verified || interrupted()) break;
      if (Date.now() - settleStart + settleIntervalSec * 1000 > settleTimeoutSec * 1000) break;
      await ctl.sleep(settleIntervalSec * 1000);
      if (interrupted()) break;
    }
    if (usageAfterCU !== null && !usageSettled) {
      warnings.push(`balance did not settle within ${settleTimeoutSec}s after the stop: actualCU is PROVISIONAL (billing lags; check \`colab usage\` later)`);
      log("usage: balance not settled; actual CU recorded as provisional");
    }
    if (lastUsage && stop.verified && lastUsage.assignments > 0) warnings.push(`colab usage still reports ${lastUsage.assignments} active assignment(s) although ${o.name} is gone (another session of this account?)`);
    timing.teardownSec = Math.round((Date.now() - tTear) / 1000);
    const actualCU = usageAfterCU === null ? null : round2(usageBefore.balance - usageAfterCU);

    const list = [...jobs.values()];
    const jobsOk = list.filter((j) => j.state === "downloaded").length;
    let outcome: Outcome;
    if (unwind?.reason === "signal" || unwind?.reason === "fatal") outcome = "interrupted";
    else if (unwind?.reason === "deadline" || unwind?.reason === "budget") outcome = "aborted-deadline";
    else if (unwind) outcome = "failed";
    else if (phaseNormal && jobsOk === list.length) outcome = "ok";
    else if (phaseNormal && jobsOk > 0) outcome = "partial"; // the runner finished, some jobs failed
    else outcome = "failed";
    const abortReason: AbortReason | undefined = unwind?.reason ?? (outcome === "failed" ? "error" : undefined);

    let exitCode: number;
    if (leak) exitCode = EXIT.toolFailure;
    else if (ctl.signal) exitCode = 128 + (SIGNO[ctl.signal] ?? 1);
    else if (outcome === "ok") exitCode = EXIT.ok;
    else if (unexpected || ctl.fatal !== undefined) exitCode = EXIT.toolFailure;
    else exitCode = unwind?.exitCode ?? EXIT.toolFailure;

    const endedAt = new Date().toISOString();
    const setupSec = lastStatus?.setup?.finishedAt && lastStatus.setup.startedAt ? Math.round(lastStatus.setup.finishedAt - lastStatus.setup.startedAt) : 0;
    const genSec = Math.round(list.reduce((s, j) => s + (j.wallSec ?? 0), 0));
    result = {
      session: o.name,
      outcome,
      exitCode,
      ...(abortReason ? { abortReason } : {}),
      ...(ctl.signal ? { signal: ctl.signal } : {}),
      ...(unwind ? { error: unwind.message } : ctl.fatal ? { error: ctl.fatal.split("\n")[0] } : {}),
      jobs: list,
      jobsTotal: list.length,
      jobsOk,
      usageBeforeCU: usageBefore.balance,
      usageAfterCU,
      actualCU,
      usageSettled,
      gpu,
      gpuRequested: o.gpuRequested ?? o.gpu,
      ...(gpuFallback ? { gpuFallback } : {}),
      rateObservedCuPerHour: rateObserved,
      estimateCU,
      stop,
      leak,
      warnings,
      startedAt,
      endedAt,
      ledgerPath: join(dir, "ledger.jsonl"),
    };

    try {
      writeSessionFile(dir, o.name, { session: o.name, outcome, abortReason, error: result.error, startedAt, endedAt, stop, jobs: list, status: lastStatus, logs, transcript });
      appendLedger(dir, {
        session: o.name,
        film: o.film,
        filmSha256: o.filmSha256 ?? null,
        gpu,
        gpuRequested: o.gpuRequested ?? o.gpu,
        ...(gpuFallback ? { gpuFallback } : {}),
        rateObservedCuPerHour: rateObserved,
        startedAt,
        endedAt,
        jobs: list.length,
        jobsOk,
        estimateCU,
        budgetCU: o.budgetCU,
        usageBeforeCU: usageBefore.balance,
        usageAfterCU,
        actualCU,
        usageSettled,
        outcome,
        ...(abortReason ? { abortReason } : {}),
        stopVerified: stop.verified,
        phases: { newSec: timing.newSec, setupSec, genSec, teardownSec: timing.teardownSec },
      });
    } catch (err) {
      warnings.push(`could not write the ledger: ${(err as Error).message}`);
    }

    // Cost facts only exist now (usage after the stop), so they are attached to the clips' meta afterwards. Run
    // records read them from there (src/record.ts) and stay byte-stable because nothing is recomputed later.
    // Attribution (PLAN §5.6): session CU x this job's gen seconds / all gen seconds of the session.
    const totalGenSec = list.reduce((s, j) => s + (j.wallSec ?? 0), 0);
    for (const j of list) {
      if (j.state !== "downloaded") continue;
      const share = totalGenSec > 0 ? (j.wallSec ?? 0) / totalGenSec : 1 / list.length;
      try {
        attachCost(o.baseDir, j.key, {
          session: o.name,
          estimateCU,
          usageBeforeCU: usageBefore.balance,
          usageAfterCU,
          sessionActualCU: actualCU,
          usageSettled,
          attributedCU: actualCU === null ? null : Math.round(actualCU * share * 10000) / 10000,
          stopped: stop.stopped,
          sessionsVerifiedEmpty: stop.verified,
        });
      } catch (err) {
        warnings.push(`could not attach cost to the cache entry of ${j.node}#${j.candidate}: ${(err as Error).message}`);
      }
    }

    if (leak) {
      // active.json stays: `colab-comfy reap` and the guard use it to find the session.
      process.stderr.write(`SESSION_LEAK: ${o.name} is still listed after ${stop.attempts} stop attempts. Run \`colab-comfy reap\` or \`colab stop -s ${o.name}\`.\n`);
    } else {
      removeActive(dir, o.name); // CLOSE: the guard sees it gone and exits
    }
  };

  try {
    // active.json BEFORE `colab new`: a crash during `new` still leaves a record for the guard and for reap.
    writeActive(dir, active);
    if (o.guard !== false) {
      try {
        active.guardPid = spawnGuard({ session: o.name, parentPid: process.pid, deadline: deadlineMs / 1000, stateDir: dir, env });
        writeActive(dir, active);
      } catch (err) {
        log(`warning: could not start the guard (${(err as Error).message}); relying on finally and signals`);
      }
    }

    // ---------------- OPEN ----------------
    log(`opening session ${o.name} (${gpu}${(o.gpuRequested ?? gpu) !== gpu ? `, chosen by --gpu ${o.gpuRequested}` : ""})`);
    const tNew = Date.now();
    let nr = await colab.newSession(o.name, gpu);
    if (nr.ok) billedFromMs = tNew;
    abortIfRequested();
    if (!nr.ok) {
      const text = `${nr.stderr}\n${nr.stdout}`;
      const why = `colab new --gpu ${gpu} ${nr.timedOut ? "timed out" : `exited ${nr.code}`}: ${tail(text.trim(), 4, 400)}`;
      const fb = o.fallback;
      if (!fb || newFailureExit(text) === EXIT.missingDependency) throw new Unwind("error", why, newFailureExit(text));
      // Exactly one session: the failed request must not have left anything behind before the fallback opens.
      let others: string[];
      try {
        others = (await colab.sessions()).map((s) => s.name);
      } catch (err) {
        throw new Unwind("error", `${why}; no fallback: cannot list sessions (${(err as Error).message.split("\n")[0]})`);
      }
      if (others.includes(o.name)) {
        const st = await stopAndVerify(colab, o.name, backoff, log);
        if (!st.verified) throw new Unwind("error", `${why}; no fallback: the half-created session could not be verified gone`);
        others = others.filter((n) => n !== o.name);
      }
      if (others.length) throw new Unwind("error", `${why}; no fallback: other session(s) active: ${others.join(", ")}`);
      log(`${gpu} unavailable (${tail(text.trim(), 1, 160).trim()}); --gpu auto falls back to ${fb.gpu}: estimate ${fb.estimateCU.toFixed(2)} CU <= budget ${o.budgetCU.toFixed(2)} CU`);
      gpuFallback = { from: gpu, to: fb.gpu, reason: tail(text.trim(), 2, 300).trim() || why };
      gpu = fb.gpu;
      rateCuPerHour = fb.rateCuPerHour;
      estimateCU = fb.estimateCU;
      estimateTotalSec = fb.totalSec;
      const tFb = Date.now();
      nr = await colab.newSession(o.name, gpu);
      if (nr.ok) billedFromMs = tFb;
      abortIfRequested();
      if (!nr.ok) {
        const t2 = `${nr.stderr}\n${nr.stdout}`;
        throw new Unwind("error", `${why}; fallback colab new --gpu ${gpu} ${nr.timedOut ? "timed out" : `exited ${nr.code}`}: ${tail(t2, 4, 400)}`, newFailureExit(t2));
      }
    }
    timing.newSec = Math.round((Date.now() - tNew) / 1000);
    const st0 = await colab.status(o.name); // A6: `new` returns after READY; one sanity call only
    if (!st0.found) throw new Unwind("error", "session not found right after `colab new`");

    // Budget guard with the REAL rate: `Usage rate` right after `new` (one session only, so it is ours).
    try {
      const u = await colab.usage();
      if (u.rate > 0) rateObserved = u.rate;
    } catch (err) {
      log(`usage after new failed: ${(err as Error).message.split("\n")[0]}; keeping the estimated rate`);
    }
    if (rateObserved !== null) {
      if (Math.abs(rateObserved - rateCuPerHour) > 0.05) log(`observed rate ${rateObserved} CU/h (estimate assumed ${rateCuPerHour})`);
      if (estimateTotalSec !== undefined) {
        const projected = cuFor(estimateTotalSec, rateObserved, o.margin ?? 1);
        if (projected > o.budgetCU) throw new Unwind("budget", `projected ${projected.toFixed(2)} CU at the observed rate ${rateObserved} CU/h exceeds the budget ${o.budgetCU.toFixed(2)} CU`);
      }
      rateCuPerHour = rateObserved;
    }
    const newDeadline = computeDeadlineMs(startedMs, { budgetCU: o.budgetCU, rateCuPerHour, maxWallSec: o.maxWallSec });
    if (newDeadline !== deadlineMs) {
      deadlineMs = newDeadline;
      active.deadline = deadlineMs / 1000; // the guard re-reads it from active.json every tick
      writeActive(dir, active);
      built = buildFor(deadlineMs); // the VM watchdog's hard deadline follows
      await writeBundle({ built, outFile: bundle, secretsEnv });
    }

    // ---------------- UPLOAD ----------------
    setActivePhase("uploading");
    execOk("mkdirs", await execStatus("fk_mkdirs.py", kickTimeoutSec));
    abortIfRequested();
    const up = await colab.upload(o.name, bundle, `${REMOTE_ROOT}/bundle.tar.gz`);
    abortIfRequested();
    if (!up.ok) throw new Unwind("error", `colab upload ${up.timedOut ? "timed out" : `exited ${up.code}`}: ${tail(up.stderr || up.stdout, 3, 300)}`);

    // ---------------- KICK ----------------
    execOk("kick", await execStatus("fk_kick.py", kickTimeoutSec));
    abortIfRequested();
    kickedAtMs = Date.now();
    setActivePhase("running");
    ctl.phase = "poll";
    log(`runner started; polling every ${pollSec}s`);

    // ---------------- POLL ----------------
    let lastUsageMs = Date.now();
    let lastHeartbeat: number | undefined;
    let lastHeartbeatChangeMs = kickedAtMs;
    let deadRunnerPolls = 0;
    let failures = 0;
    for (;;) {
      if (ctl.stopRequested) {
        await salvage();
        abortIfRequested();
      }
      if (Date.now() > deadlineMs) {
        await salvage();
        throw new Unwind("deadline", "wall-clock deadline reached");
      }
      if (usageEverySec > 0 && Date.now() - lastUsageMs >= usageEverySec * 1000) {
        lastUsageMs = Date.now();
        let used: number | undefined;
        try {
          used = usageBefore.balance - (await colab.usage()).balance;
        } catch (err) {
          log(`usage sample failed: ${(err as Error).message.split("\n")[0]}`); // a safety net, not a gate
        }
        if (used !== undefined && used >= o.budgetCU - 0.05) {
          await salvage();
          throw new Unwind("budget", `budget exhausted: ${round2(used)} CU used of ${o.budgetCU}`);
        }
      }

      const st = await pollOnce();
      if (ctl.stopRequested) continue; // the poll may have been killed by a signal: take the salvage path at the top
      if (st === null) {
        failures++;
        log(`poll failed (${failures}/3)`);
        if (failures >= 3) throw new Unwind("session-lost", "3 consecutive poll failures: the session is lost or unresponsive");
      } else {
        failures = 0;
        if (!st.pending) {
          const releasing = isReleasing(st as Record<string, unknown>);
          await absorb(st, releasing ? 1 : 3); // a releasing VM is going away: one attempt, then STOP
          if (releasing) throw new Unwind("vm-released", "the VM runner released the session (watchdog)");
          if (TERMINAL_PHASES.has(String(st.phase))) {
            phaseNormal = st.phase === "done"; // jobs still "not-run" now are lost with the VM
            break;
          }
          // VM health: the heartbeat must keep moving, and a dead runner never recovers (no retry).
          if (st.heartbeatAt !== lastHeartbeat) {
            lastHeartbeat = st.heartbeatAt;
            lastHeartbeatChangeMs = Date.now();
          } else if (Date.now() - lastHeartbeatChangeMs > staleSec * 1000) {
            await salvage();
            throw new Unwind("vm-stale", `the VM heartbeat has not moved for ${staleSec}s`);
          }
          // Two consecutive polls: the runner may exit right after the status that was read a moment earlier.
          deadRunnerPolls = st.runnerAlive === false ? deadRunnerPolls + 1 : 0;
          if (deadRunnerPolls >= 2) {
            await salvage();
            throw new Unwind("vm-stale", "the VM runner process died");
          }
        }
      }
      await ctl.sleep(pollSec * 1000);
    }

    // ---------------- COLLECT ----------------
    ctl.phase = "collect";
    if (!ctl.skipSalvage && collectSec > 0) logs = await collectLogs(colab, o.name, collectSec, work);
  } catch (err) {
    unexpected = !(err instanceof Unwind);
    unwind = err instanceof Unwind ? err : new Unwind("error", `unexpected error: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
    log(`aborting: ${unwind.message.split("\n")[0]}`);
  } finally {
    try {
      await finish();
    } finally {
      rmSync(work, { recursive: true, force: true });
      uninstall();
    }
  }
  return result;
}

/** Tail of the VM logs (redacted, bounded). Failures are ignored: logs are a convenience. */
async function collectLogs(colab: Colab, name: string, budgetSec: number, work: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const run = (async () => {
    for (const which of ["runner", "setup", "comfy"]) {
      const local = join(work, `${which}.log`);
      try {
        const r = await colab.download(name, `${REMOTE_ROOT}/logs/${which}.log`, local);
        if (r.ok) out[which] = redact(tail(readFileSync(local, "utf8"), 100, 20_000));
      } catch {
        // missing log: skip
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run,
    new Promise<void>((r) => {
      timer = setTimeout(() => {
        colab.abortInFlight();
        r();
      }, budgetSec * 1000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return out;
}
