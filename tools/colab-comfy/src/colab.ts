// Async wrapper over the `colab` CLI (0.7.4; behaviour verified in M0-FINDINGS, referenced as F*/A*).
//
// Rules this file enforces:
//  * Bun.spawn only (never spawnSync): the event loop must stay free for signal handlers (PLAN §6.4).
//  * Every call has a host timeout with kill; the CLI's own --timeout is unreliable (F2).
//  * Every captured stdout/stderr is redacted before it leaves this module (A5).
//  * `exec` success is decided ONLY by the `FKSTATUS {json}` line; its exit code is ignored (A1).
//    A host timeout kills the client, then runs `restart-kernel`, because a killed exec client leaves
//    the next exec hanging forever (A2/F2). Secrets are never passed via `--env` (A3): no function
//    here accepts env pairs at all.
//  * upload/download/new/version rc IS meaningful; `stop` rc is 0 even for a missing session (A7), so
//    it reports a parsed `notFound` flag, and release must be verified with `sessions`/`usage`.
//
// Deliberately no retries here: callers decide (generation is never retried; teardown is, in session.ts).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ColabComfyError, EXIT } from "./errors.ts";
import { redact, redactDeep } from "./redact.ts";

export interface ColabOptions {
  /** Executable; default `colab` from PATH (tests put the fake shim first on PATH). */
  bin?: string;
  /** `--auth` value; default env COLAB_COMFY_AUTH or "adc". */
  auth?: string;
  /** `--config` value; default env COLAB_CLI_CONFIG (omitted when unset). */
  config?: string;
  /** Environment for the child process; default process.env. */
  env?: Record<string, string | undefined>;
  /** Per-command default host timeouts in milliseconds. */
  timeoutsMs?: Partial<Record<keyof typeof DEFAULT_TIMEOUTS_MS, number>>;
  /** Called with every finished call; output is already redacted. */
  onCall?: (entry: CallLogEntry) => void;
}

export const DEFAULT_TIMEOUTS_MS = {
  version: 30_000,
  sessions: 60_000,
  usage: 60_000,
  status: 60_000,
  new: 420_000,
  upload: 600_000,
  download: 600_000,
  stop: 120_000,
  restartKernel: 60_000,
} as const;

export interface CallLogEntry {
  /** argv after the binary, global flags included; contains no secrets by construction. */
  args: string[];
  code: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

/** Result of one finished `colab` invocation; stdout/stderr are redacted. */
export interface CallResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SessionInfo {
  name: string;
  endpoint: string;
  hardware: string;
  shape: string;
  variant: string;
}

export interface UsageInfo {
  balance: number;
  /** CU per hour. */
  rate: number;
  assignments: number;
}

export type StatusInfo =
  | { found: false }
  | { found: true; name: string; hardware: string; state: "IDLE" | "BUSY"; busyWith?: string; lastExecution?: string };

export interface ExecResult {
  /** Parsed payload of the last `FKSTATUS ` line, or null (no marker / invalid JSON / timeout). */
  fkstatus: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  /** rc of the client; informational only, never evidence of success (A1). */
  code: number | null;
  timedOut: boolean;
  /** The session no longer exists on the server (self-release, preemption, stop). */
  sessionNotFound: boolean;
  /** After a host timeout: did `restart-kernel` succeed? undefined when no timeout happened. */
  kernelRestarted?: boolean;
}

export interface StopResult extends CallResult {
  /** `Session 'NAME' not found.` was printed: nothing was stopped (A7). */
  notFound: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const NOT_FOUND = /Session '[^']*' not found/;
const SESSION_LINE = /^\[([^\]]+)\]\s+(\S+)\s*\|\s*Hardware:\s*([^|]+?)\s*\|\s*Shape:\s*([^|]+?)\s*\|\s*Variant:\s*([^|]+?)\s*(?:\||$)/;
const FKSTATUS_PREFIX = "FKSTATUS ";

// ---- pure parsers (unit-tested on the M0 F1 strings) ----

/** `colab sessions` -> sessions. Unknown non-`[colab]` lines throw: a silently dropped line could hide a leaked VM. */
export function parseSessions(stdout: string): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = SESSION_LINE.exec(line);
    if (m) {
      out.push({ name: m[1]!, endpoint: m[2]!, hardware: m[3]!, shape: m[4]!, variant: m[5]! });
      continue;
    }
    if (line.startsWith("[colab] ")) continue; // "No active sessions found on server.", "Pruned N stale local session(s)."
    throw new ColabComfyError(EXIT.toolFailure, [{ code: "colab-parse", message: `cannot parse \`colab sessions\` line: ${redact(line)}` }]);
  }
  return out;
}

export function parseUsage(stdout: string): UsageInfo {
  const balance = /Current balance:\s*(-?\d+(?:\.\d+)?)/i.exec(stdout);
  const rate = /Usage rate:\s*(-?\d+(?:\.\d+)?)\s*\/\s*hr/i.exec(stdout);
  const assignments = /Active assignments:\s*(\d+)/i.exec(stdout);
  if (!balance || !rate || !assignments) {
    throw new ColabComfyError(EXIT.toolFailure, [{ code: "colab-parse", message: `cannot parse \`colab usage\` output: ${redact(stdout.trim()).slice(0, 300)}` }]);
  }
  return { balance: Number(balance[1]), rate: Number(rate[1]), assignments: Number(assignments[1]) };
}

export function parseStatus(stdout: string): StatusInfo {
  if (NOT_FOUND.test(stdout)) return { found: false };
  const m = /^\[([^\]]+)\]\s+\S+\s*\|\s*Hardware:\s*([^|]+?)\s*\|.*\|\s*Status:\s*(IDLE|BUSY)(?:\s*\((.*)\))?\s*$/m.exec(stdout);
  if (!m) {
    throw new ColabComfyError(EXIT.toolFailure, [{ code: "colab-parse", message: `cannot parse \`colab status\` output: ${redact(stdout.trim()).slice(0, 300)}` }]);
  }
  const last = /^\s*Last Execution:\s*(.+?)\s*$/m.exec(stdout);
  return {
    found: true,
    name: m[1]!,
    hardware: m[2]!,
    state: m[3] as "IDLE" | "BUSY",
    ...(m[4] ? { busyWith: m[4] } : {}),
    ...(last ? { lastExecution: last[1]! } : {}),
  };
}

/** Last `FKSTATUS {json}` line whose payload is a JSON object; the kernel may print other noise (A1). */
export function parseFkStatus(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\r$/, "");
    if (!line.startsWith(FKSTATUS_PREFIX)) continue;
    try {
      const v = JSON.parse(line.slice(FKSTATUS_PREFIX.length));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // fall through to an earlier line
    }
  }
  return null;
}

/** The VM runner asked the host to stop (watchdog fired; fk_poll.py also unassigns): go straight to STOP/VERIFY. */
export function isReleasing(fk: Record<string, unknown> | null): boolean {
  return fk?.releasing === true;
}

// ---- driver ----

export class Colab {
  private readonly bin: string;
  private readonly globals: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly timeouts: Record<keyof typeof DEFAULT_TIMEOUTS_MS, number>;
  private readonly onCall?: (e: CallLogEntry) => void;
  private readonly inFlight = new Set<ReturnType<typeof Bun.spawn>>();

  constructor(opts: ColabOptions = {}) {
    const env = opts.env ?? process.env;
    this.env = env;
    this.bin = opts.bin ?? "colab";
    const auth = opts.auth ?? env.COLAB_COMFY_AUTH ?? "adc";
    const config = opts.config ?? env.COLAB_CLI_CONFIG;
    this.globals = ["--auth", auth, ...(config ? ["--config", config] : [])];
    this.timeouts = { ...DEFAULT_TIMEOUTS_MS, ...opts.timeoutsMs };
    this.onCall = opts.onCall;
  }

  /** Spawn `colab <globals> <args>`; never throws for a non-zero exit, only when the binary cannot run. */
  async run(args: string[], timeoutMs: number): Promise<CallResult> {
    const argv = [this.bin, ...this.globals, ...args];
    const t0 = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { env: this.env as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      throw new ColabComfyError(EXIT.missingDependency, [
        { code: "missing-dependency", message: `cannot run "${this.bin}": ${redact((err as Error).message)}`, hint: "install the colab CLI and put it on PATH" },
      ]);
    }
    this.inFlight.add(proc);
    const buf = { out: "", err: "" };
    const pump = async (s: ReadableStream<Uint8Array>, k: "out" | "err") => {
      const dec = new TextDecoder();
      for await (const chunk of s) buf[k] += dec.decode(chunk, { stream: true });
      buf[k] += dec.decode();
    };
    const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, "out"), pump(proc.stderr as ReadableStream<Uint8Array>, "err")]).catch(() => {});

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, timeoutMs);
    const code = await proc.exited;
    this.inFlight.delete(proc);
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    // A grandchild may keep the pipes open after the client died: never wait on them for long.
    await Promise.race([pumps, sleep(timedOut ? 500 : 5000)]);

    const result: CallResult = {
      ok: !timedOut && code === 0,
      code: timedOut ? null : code,
      timedOut,
      stdout: redact(buf.out),
      stderr: redact(buf.err),
    };
    this.onCall?.({ args: argv.slice(1), code: result.code, timedOut, ms: Date.now() - t0, stdout: result.stdout, stderr: result.stderr });
    return result;
  }

  /**
   * Kill every `colab` client currently running (signal handling, PLAN §6.4: a pending `new`/`exec`
   * must not delay STOP). The affected calls return not-ok. Killing an `exec` client wedges that
   * session's next exec (F2), which is irrelevant because the next call is `stop`.
   */
  abortInFlight(): void {
    for (const p of this.inFlight) p.kill("SIGTERM");
  }

  /** run() + raise on failure, for read-only queries whose output we must parse. */
  private async query(args: string[], timeoutMs: number): Promise<CallResult> {
    const r = await this.run(args, timeoutMs);
    if (!r.ok) throw toolFailure(args[0]!, r);
    return r;
  }

  async version(): Promise<string> {
    const r = await this.query(["version"], this.timeouts.version);
    const m = /\d+\.\d+\.\d+(?:[-+.\w]*)?/.exec(r.stdout);
    return m ? m[0] : r.stdout.trim();
  }

  async sessions(): Promise<SessionInfo[]> {
    return parseSessions((await this.query(["sessions"], this.timeouts.sessions)).stdout);
  }

  async usage(): Promise<UsageInfo> {
    return parseUsage((await this.query(["usage"], this.timeouts.usage)).stdout);
  }

  async status(name: string): Promise<StatusInfo> {
    return parseStatus((await this.query(["status", "-s", name], this.timeouts.status)).stdout);
  }

  /** `--gpu` is omitted for CPU/undefined. Returns the raw result: the caller must STOP even after a failed new. */
  async newSession(name: string, gpu?: string): Promise<CallResult> {
    const g = gpu && gpu.toUpperCase() !== "CPU" ? ["--gpu", gpu] : [];
    return this.run(["new", "-s", name, ...g], this.timeouts.new);
  }

  /**
   * Run a short script inside the session's kernel. `timeoutSec` is the HOST deadline (kick 120, poll 60; A2).
   * The CLI's own --timeout is set well above it so the host kill is the authority.
   */
  async exec(name: string, file: string, timeoutSec: number): Promise<ExecResult> {
    const cliTimeout = Math.ceil(timeoutSec) + 30;
    const r = await this.run(["exec", "-s", name, "-f", file, "--timeout", String(cliTimeout)], timeoutSec * 1000);
    const fk = r.timedOut ? null : parseFkStatus(r.stdout);
    const res: ExecResult = {
      fkstatus: fk ? redactDeep(fk) : null,
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.code,
      timedOut: r.timedOut,
      sessionNotFound: NOT_FOUND.test(r.stdout) || NOT_FOUND.test(r.stderr),
    };
    if (r.timedOut) {
      // A2: the killed client leaves the kernel marked busy and the next exec would hang: restart first.
      res.kernelRestarted = (await this.restartKernel(name)).ok;
    }
    return res;
  }

  /** rc is meaningful. The remote parent dir must already exist (F4/A4): create it with an exec first. */
  upload(name: string, local: string, remote: string): Promise<CallResult> {
    return this.run(["upload", "-s", name, local, remote], this.timeouts.upload);
  }

  /** rc is meaningful. The local parent dir is created here (F4/A4). */
  async download(name: string, remote: string, local: string): Promise<CallResult> {
    mkdirSync(dirname(local), { recursive: true });
    return this.run(["download", "-s", name, remote, local], this.timeouts.download);
  }

  restartKernel(name: string): Promise<CallResult> {
    return this.run(["restart-kernel", "-s", name], this.timeouts.restartKernel);
  }

  /** rc is 0 for an already-gone session (A7): `notFound` says so; verification must use sessions()/usage(). */
  async stop(name: string): Promise<StopResult> {
    const r = await this.run(["stop", "-s", name], this.timeouts.stop);
    return { ...r, notFound: NOT_FOUND.test(r.stdout) || NOT_FOUND.test(r.stderr) };
  }
}

function toolFailure(sub: string, r: CallResult): ColabComfyError {
  const why = r.timedOut ? "timed out" : `exited ${r.code}`;
  const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-6).join("\n");
  return new ColabComfyError(EXIT.toolFailure, [{ code: "colab-failed", message: `colab ${sub} ${why}${tail ? `:\n${tail}` : ""}` }]);
}
