// Fake `colab` CLI for tests (PLAN M4, M0-FINDINGS A12). It contacts nothing and spends nothing.
//
// Use: put `test/bin` first on PATH (see fakeColabEnv()) and set FAKE_COLAB_STATE=<dir>.
// It emulates the behaviour M0 measured on the real colab 0.7.4:
//   * human-readable outputs exactly like F1 (`sessions`, `status`, `usage`, `new`);
//   * `exec -s N -f file.py` runs the file with python3 locally. FK_ROOT -> <state>/sessions/N/content/fk
//     and FAKE_COLAB_CONTENT -> <state>/sessions/N/content (VM scripts read FK_ROOT, default /content/fk).
//     Exit code is ALWAYS 0; tracebacks go to stderr; `--timeout` is ignored; `--env K=V` is prepended
//     to the code as `os.environ['K'] = 'V'` (so it would show up in tracebacks).
//   * if an exec client is killed, the next exec hangs until `restart-kernel` (stale BUSY marker, F2).
//     The cell itself keeps running detached, like the remote cell did.
//   * `upload` into a missing remote dir: rc 1 + a 500 whose URL carries a FAKE proxy token (redaction tests);
//     `download` needs the local parent dir; `stop` on a missing session is rc 0 + "Session 'N' not found.".
//   * `google.colab.runtime.unassign()` is stubbed by test/fake-pylib: the session then disappears.
//   * Each session has a nominal per-GPU rate (CU/h; FAKE_COLAB_RATES="L4=1.71,A100=5.3" overrides the
//     defaults L4 1.71 / A100 5.3 / other 1.71) which `usage` shows as `Usage rate`, like the real CLI.
//     Billing charges rate/3600 per second of session life (2 decimals) - unless FAKE_COLAB_CU_PER_SEC
//     accelerates it for tests: then an L4 charges that many CU per second and other GPUs proportionally
//     more (rate/1.71), while `Usage rate` still shows the nominal rate.
//     FAKE_COLAB_CU_PER_SEC="" switches the acceleration off (billing = the shown rate).
//     FAKE_COLAB_SETTLE_LAG_MS=N: billing lags N ms behind real time, like the real balance after a stop
//     (M8 A100: 0.16 CU right after the stop, 0.60 CU settled): the balance only reflects usage up to now-N.
//   * FAKE_COLAB_UNAVAILABLE=A100[,G4]: `new --gpu <that>` fails (rc 1) like an exhausted accelerator pool.
// Fault injection (env): FAKE_COLAB_FAIL=new|exec|download|stop|stop-always (comma list, `kind:N` = first
// N calls only; `stop` defaults to 1, `stop-always` never recovers), FAKE_COLAB_HANG=exec[:N] (the Nth exec
// call, default first, hangs), FAKE_COLAB_DROP=after:N (session vanishes after N exec calls: preemption).
// Every invocation's argv is appended to <state>/calls.log (no secrets ever appear in argv).

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const FAKE_BIN_DIR = join(import.meta.dir, "bin");
export const FAKE_PYLIB = join(import.meta.dir, "fake-pylib");

// Detached kernel processes can import the stub without PYTHONDONTWRITEBYTECODE,
// leaving __pycache__ under a tracked dir (fails `check:tracked`). Sweep on exit.
function sweepPycache(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === "__pycache__") rmSync(p, { recursive: true, force: true });
    else sweepPycache(p);
  }
}
process.on("exit", () => sweepPycache(FAKE_PYLIB));
export const FAKE_TOKEN = "FAKE.JWT.eyJhbGciOiJFUzI1NiJ9.fake.sig";

/** Environment that makes `colab` resolve to the fake (the caller's env is preserved). */
export function fakeColabEnv(stateDir: string, extra: Record<string, string> = {}, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.PATH = `${FAKE_BIN_DIR}:${env.PATH ?? ""}`;
  env.FAKE_COLAB_BUN = process.execPath;
  env.FAKE_COLAB_STATE = stateDir;
  // The helper's post-stop balance settling polls every 30 s in production; tests poll fast unless they override it.
  env.COLAB_COMFY_SETTLE_INTERVAL_SEC ??= "0.05";
  env.COLAB_COMFY_SETTLE_TIMEOUT_SEC ??= "5";
  return { ...env, ...extra };
}

export interface FakeCall {
  /** Subcommand (`new`, `exec`, ...) with global flags removed. */
  sub: string;
  args: string[];
  line: string;
}

export function readCalls(stateDir: string): FakeCall[] {
  const p = join(stateDir, "calls.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const argv = line.split(" ");
      const rest = stripGlobals(argv).rest;
      return { sub: rest[0] ?? "", args: rest.slice(1), line };
    });
}

/** Path of a session's emulated /content inside the state dir (for assertions). */
export function sessionContent(stateDir: string, name: string): string {
  return join(stateDir, "sessions", name, "content");
}

// ---------------------------------------------------------------------------------------------------

const GLOBAL_WITH_VALUE = new Set(["--auth", "--config", "--client-oauth-config"]);

function stripGlobals(argv: string[]): { rest: string[] } {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (GLOBAL_WITH_VALUE.has(argv[i]!)) i++;
    else rest.push(argv[i]!);
  }
  return { rest };
}

interface Meta {
  name: string;
  endpoint: string;
  hardware: string;
  createdAtMs: number;
  releasedAtMs?: number;
  releasedBy?: "stop" | "unassign" | "drop";
  pruned?: boolean;
  execCalls: number;
  /** Billing speed for this session, CU per (real) second. */
  cuPerSec?: number;
  /** Nominal rate shown by `usage`, CU/h. */
  ratePerHour?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const STATE = process.env.FAKE_COLAB_STATE ?? "";
const sessDir = (name: string) => join(STATE, "sessions", name);
const metaPath = (name: string) => join(sessDir(name), "meta.json");
const ledgerPath = () => join(STATE, "ledger.json");
const cuPerSec = () => Number(process.env.FAKE_COLAB_CU_PER_SEC || 1.7 / 3600);

function out(s: string) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}
function err(s: string) {
  process.stderr.write(s.endsWith("\n") ? s : s + "\n");
}

function loadMeta(name: string): Meta | null {
  try {
    return JSON.parse(readFileSync(metaPath(name), "utf8")) as Meta;
  } catch {
    return null;
  }
}
function saveMeta(m: Meta) {
  mkdirSync(sessDir(m.name), { recursive: true });
  writeFileSync(metaPath(m.name), JSON.stringify(m));
}
interface FakeLedger {
  /** True total spend of released sessions (tests read it as ground truth). */
  spent: number;
  /** Released sessions, for the billing-lag view of `usage`. */
  released?: { createdAtMs: number; releasedAtMs: number; cuPerSec: number }[];
}
function readLedgerFile(): FakeLedger {
  try {
    return JSON.parse(readFileSync(ledgerPath(), "utf8")) as FakeLedger;
  } catch {
    return { spent: 0 };
  }
}
function spent(): number {
  return readLedgerFile().spent;
}
function addSpent(cu: number, interval?: { createdAtMs: number; releasedAtMs: number; cuPerSec: number }) {
  const l = readLedgerFile();
  l.spent += cu;
  if (interval) (l.released ??= []).push(interval);
  writeFileSync(ledgerPath(), JSON.stringify(l));
}
const settleLagMs = () => Number(process.env.FAKE_COLAB_SETTLE_LAG_MS ?? 0);
/** CU of [from, to] that billing has seen by `now` (billing lags settleLagMs behind). */
function billed(fromMs: number, toMs: number, rate: number, now: number): number {
  return (Math.max(0, Math.min(toMs, now - settleLagMs()) - fromMs) / 1000) * rate;
}
const BASE_RATE = 1.71;
const DEFAULT_RATES: Record<string, number> = { L4: BASE_RATE, A100: 5.3 };
function nominalRate(hardware: string): number {
  const gpu = hardware.replace(/^GPU\s+/, "").toUpperCase();
  for (const pair of (process.env.FAKE_COLAB_RATES ?? "").split(",")) {
    const [k, v] = pair.split("=");
    if (k && v && k.trim().toUpperCase() === gpu) return Number(v);
  }
  return DEFAULT_RATES[gpu] ?? BASE_RATE;
}
function billingSpeed(ratePerHour: number): number {
  const accel = process.env.FAKE_COLAB_CU_PER_SEC;
  return accel !== undefined && accel !== "" ? Number(accel) * (ratePerHour / BASE_RATE) : ratePerHour / 3600;
}
const metaRate = (m: Meta) => m.cuPerSec ?? cuPerSec();
const metaRatePerHour = (m: Meta) => m.ratePerHour ?? metaRate(m) * 3600;

function release(m: Meta, by: NonNullable<Meta["releasedBy"]>, atMs = Date.now()) {
  if (m.releasedAtMs) return;
  m.releasedAtMs = atMs;
  m.releasedBy = by;
  addSpent(((atMs - m.createdAtMs) / 1000) * metaRate(m), { createdAtMs: m.createdAtMs, releasedAtMs: atMs, cuPerSec: metaRate(m) });
  saveMeta(m);
  killVmProcesses(m.name);
}

/**
 * A released VM takes its processes with it. Without this, the detached runner of a stopped session kept idling and
 * its status writer rewrote status.json into the next session of the same name (session names have minute
 * resolution), so a batch started in the same minute read the previous batch's `done` status (flaky E3).
 */
function killVmProcesses(name: string) {
  try {
    const pid = Number(readFileSync(join(sessDir(name), "content", "fk", "runner.pid"), "utf8").trim());
    if (pid > 1) {
      try {
        process.kill(-pid, "SIGKILL"); // setsid'd runner: pid == process group id
      } catch {}
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  } catch {}
}

function allMetas(): Meta[] {
  const root = join(STATE, "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => loadMeta(n))
    .filter((m): m is Meta => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Pick up releases done from inside the VM (the unassign() stub drops a `released` file). */
function sweep() {
  for (const m of allMetas()) {
    if (m.releasedAtMs) continue;
    const f = join(sessDir(m.name), "released");
    if (existsSync(f)) release(m, "unassign", Number(readFileSync(f, "utf8")) || Date.now());
  }
}

function active(name: string): Meta | null {
  const m = loadMeta(name);
  return m && !m.releasedAtMs ? m : null;
}

function notFound(name: string) {
  out(`[colab] Session '${name}' not found.`);
}

/** Map a remote path (`/content/...` or relative) into the emulated VM. */
function mapRemote(name: string, remote: string): string {
  const content = join(sessDir(name), "content");
  if (remote === "/content" || remote.startsWith("/content/")) return join(content, remote.slice("/content".length));
  if (remote.startsWith("/")) return join(sessDir(name), "root", remote);
  return join(content, remote);
}

function failNow(kind: string): boolean {
  for (const tok of (process.env.FAKE_COLAB_FAIL ?? "").split(",").filter(Boolean)) {
    const [k, n] = tok.split(":");
    const matches = k === kind || (kind === "stop" && k === "stop-always");
    if (!matches) continue;
    const limit = k === "stop-always" ? Infinity : n ? Number(n) : k === "stop" ? 1 : Infinity;
    const f = join(STATE, `fail-${kind}.count`);
    const cnt = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
    if (cnt < limit) {
      writeFileSync(f, String(cnt + 1));
      return true;
    }
  }
  return false;
}

interface Parsed {
  sub: string;
  session?: string;
  file?: string;
  gpu?: string;
  envPairs: string[];
  positional: string[];
}

function parse(rest: string[]): Parsed {
  const p: Parsed = { sub: rest[0] ?? "", envPairs: [], positional: [] };
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-s" || a === "--session") p.session = rest[++i];
    else if (a === "-f" || a === "--file") p.file = rest[++i];
    else if (a === "--gpu") p.gpu = rest[++i];
    else if (a === "--timeout") i++; // ignored, exactly like the real CLI (F2)
    else if (a === "--env") p.envPairs.push(rest[++i] ?? "");
    else p.positional.push(a);
  }
  return p;
}

// ---- commands -----------------------------------------------------------------------------------

function cmdSessions(): number {
  sweep();
  const metas = allMetas();
  const pruned = metas.filter((m) => m.releasedAtMs && (m.releasedBy === "unassign" || m.releasedBy === "drop") && !m.pruned);
  if (pruned.length) {
    for (const m of pruned) saveMeta({ ...m, pruned: true });
    out(`[colab] Pruned ${pruned.length} stale local session(s).`);
  }
  const live = metas.filter((m) => !m.releasedAtMs);
  if (!live.length) {
    out("[colab] No active sessions found on server.");
    return 0;
  }
  for (const m of live) out(`[${m.name}] ${m.endpoint} | Hardware: ${m.hardware} | Shape: Standard | Variant: DEFAULT`);
  return 0;
}

function cmdUsage(): number {
  sweep();
  const live = allMetas().filter((m) => !m.releasedAtMs);
  const now = Date.now();
  const initial = Number(process.env.FAKE_COLAB_BALANCE ?? 100);
  const l = readLedgerFile();
  // Released sessions not yet fully billed: subtract what billing has not seen yet (0 without a lag).
  const unbilled = (l.released ?? []).reduce((s, r) => s + ((r.releasedAtMs - r.createdAtMs) / 1000) * r.cuPerSec - billed(r.createdAtMs, r.releasedAtMs, r.cuPerSec, now), 0);
  const running = live.reduce((s, m) => s + billed(m.createdAtMs, Infinity, metaRate(m), now), 0);
  out(`Current balance: ${(initial - (l.spent - unbilled) - running).toFixed(2)} compute units`);
  out(`Usage rate: ${live.reduce((s, m) => s + metaRatePerHour(m), 0).toFixed(2)}/hr`);
  out(`Active assignments: ${live.length}`);
  return 0;
}

function lockOf(name: string): { pid: number; file: string } | null {
  try {
    return JSON.parse(readFileSync(join(sessDir(name), "exec.lock"), "utf8"));
  } catch {
    return null;
  }
}

function cmdStatus(p: Parsed): number {
  sweep();
  const m = p.session ? active(p.session) : null;
  if (!m) return notFound(p.session ?? ""), 0;
  const lock = lockOf(m.name);
  out(`[${m.name}] ${m.endpoint} | Hardware: ${m.hardware} | Shape: Standard | Variant: DEFAULT | Status: ${lock ? `BUSY (exec(${lock.file}))` : "IDLE"}`);
  return 0;
}

function cmdNew(p: Parsed): number {
  const name = p.session ?? "";
  if (!name) return err("Error: --session is required"), 2;
  sweep();
  if (failNow("new")) return err("Error: failed to allocate a runtime (injected by FAKE_COLAB_FAIL=new)"), 1;
  if (active(name)) return err(`Error: Session '${name}' already exists.`), 1;
  const unavailable = (process.env.FAKE_COLAB_UNAVAILABLE ?? "").split(",").map((g) => g.trim().toUpperCase()).filter(Boolean);
  if (p.gpu && unavailable.includes(p.gpu.toUpperCase())) {
    return err(`Error: Unable to assign a ${p.gpu} runtime: no ${p.gpu} accelerators are available right now (injected by FAKE_COLAB_UNAVAILABLE).`), 1;
  }
  out(`[colab] Creating session '${name}'...`);
  rmSync(sessDir(name), { recursive: true, force: true }); // a fresh VM has an empty /content
  mkdirSync(join(sessDir(name), "content"), { recursive: true });
  const gpu = p.gpu && p.gpu.toUpperCase() !== "CPU" ? p.gpu : undefined;
  const hardware = gpu ? `GPU ${gpu}` : "CPU";
  saveMeta({ name, endpoint: `https://fake-colab.invalid/runtime/${name}`, hardware, createdAtMs: Date.now(), execCalls: 0, ratePerHour: nominalRate(hardware), cuPerSec: billingSpeed(nominalRate(hardware)) });
  out("[colab] Session READY.");
  return 0;
}

function hangsOn(callNo: number): boolean {
  const spec = (process.env.FAKE_COLAB_HANG ?? "").split(",").find((t) => t.startsWith("exec"));
  if (!spec) return false;
  return callNo === Number(spec.split(":")[1] ?? 1);
}

function dropAfter(): number | undefined {
  const m = /^after:(\d+)$/.exec(process.env.FAKE_COLAB_DROP ?? "");
  return m ? Number(m[1]) : undefined;
}

async function cmdExec(p: Parsed): Promise<number> {
  sweep();
  const name = p.session ?? "";
  let m = active(name);
  if (!m) return notFound(name), 0;
  if (!p.file || !existsSync(p.file)) return out(`[colab] Local file '${p.file}' not found.`), 1;
  if (failNow("exec")) return err("Error: exec transport failure (injected by FAKE_COLAB_FAIL=exec)"), 1;

  const dir = sessDir(name);
  const lockFile = join(dir, "exec.lock");
  // Wait for the previous exec. A killed client never removes its lock: that wait ends only at restart-kernel (F2).
  for (;;) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, file: basename(p.file) }), { flag: "wx" });
      break;
    } catch {
      await sleep(100);
      sweep();
      if (!active(name)) return notFound(name), 0;
    }
  }
  m = active(name)!;
  m.execCalls++;
  saveMeta(m);
  if (hangsOn(m.execCalls)) {
    setInterval(() => {}, 1 << 30); // hang forever; the host must kill us
    await new Promise<never>(() => {});
  }

  const content = join(dir, "content");
  const prelude = p.envPairs
    .map((kv) => {
      const i = kv.indexOf("=");
      return `import os; os.environ[${JSON.stringify(kv.slice(0, i))}] = ${JSON.stringify(kv.slice(i + 1))}\n`;
    })
    .join("");
  const codeFile = join(dir, `cell-${m.execCalls}.py`);
  writeFileSync(codeFile, prelude + readFileSync(p.file, "utf8"));
  const outFile = join(dir, `cell-${m.execCalls}.out`);
  const errFile = join(dir, `cell-${m.execCalls}.err`);
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  const child = spawn("python3", [codeFile], {
    cwd: content,
    detached: true, // the "remote cell" outlives a killed client
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: [FAKE_PYLIB, process.env.PYTHONPATH].filter(Boolean).join(":"),
      FK_ROOT: join(content, "fk"),
      FAKE_COLAB_CONTENT: content,
      FAKE_COLAB_SESSION_DIR: dir,
    },
  });
  closeSync(outFd);
  closeSync(errFd);
  writeFileSync(join(dir, "cell.pid"), String(child.pid));
  const code: number | null = await new Promise((res) => {
    child.on("exit", (c) => res(c));
    child.on("error", () => res(127));
  });
  child.unref();

  rmSync(lockFile, { force: true });
  process.stdout.write(readFileSync(outFile, "utf8"));
  let stderrText = readFileSync(errFile, "utf8");
  if (code !== 0 && !stderrText.includes("Traceback")) {
    stderrText += `An exception has occurred, use %tb to see the full traceback.\n\nSystemExit: ${code}\n`;
  }
  process.stderr.write(stderrText);

  const after = loadMeta(name);
  const n = dropAfter();
  if (after && !after.releasedAtMs && n !== undefined && after.execCalls >= n) release(after, "drop");
  return 0; // exec rc is always 0, even for tracebacks (F2)
}

function cmdUpload(p: Parsed): number {
  sweep();
  const name = p.session ?? "";
  const [local, remote] = p.positional;
  if (!active(name)) return notFound(name), 1;
  if (!local || !remote) return err("Error: usage: colab upload -s NAME LOCAL REMOTE"), 2;
  if (!existsSync(local) || !statSync(local).isFile()) return out(`[colab] Local file '${local}' not found.`), 1;
  const target = mapRemote(name, remote);
  if (!existsSync(dirname(target))) {
    // M0 F4: the real 500 message embeds the full runtime URL including the proxy token.
    err(
      `Error: 500 Server Error: Internal Server Error for url: https://fake-colab.invalid/runtime/${name}/api/contents/${remote.replace(/^\//, "")}` +
        `?colab-runtime-proxy-token=${FAKE_TOKEN}&authuser=0`,
    );
    return 1;
  }
  copyFileSync(local, target);
  out(`[colab] Uploaded '${local}' to '${remote}'`);
  return 0;
}

function cmdDownload(p: Parsed): number {
  sweep();
  const name = p.session ?? "";
  const [remote, local] = p.positional;
  if (!active(name)) return notFound(name), 1;
  if (!remote || !local) return err("Error: usage: colab download -s NAME REMOTE LOCAL"), 2;
  if (failNow("download")) return err("Download failed: transfer interrupted (injected by FAKE_COLAB_FAIL=download)"), 1;
  const src = mapRemote(name, remote);
  if (!existsSync(src) || !statSync(src).isFile()) return err(`Download failed: File or directory not found: ${remote}`), 1;
  if (!existsSync(dirname(local))) return err(`[Errno 2] No such file or directory: '${local}'`), 1;
  copyFileSync(src, local);
  out(`[colab] Downloaded '${remote}' to '${local}'`);
  return 0;
}

function cmdStop(p: Parsed): number {
  sweep();
  const name = p.session ?? "";
  const m = active(name);
  if (!m) return notFound(name), 0; // rc 0 even when the session is gone (A7)
  if (failNow("stop")) return err("Error: could not release the runtime (injected by FAKE_COLAB_FAIL=stop)"), 1;
  release(m, "stop");
  out(`[colab] Session '${name}' stopped.`);
  return 0;
}

function cmdRestartKernel(p: Parsed): number {
  sweep();
  const name = p.session ?? "";
  if (!active(name)) return notFound(name), 0;
  try {
    process.kill(Number(readFileSync(join(sessDir(name), "cell.pid"), "utf8")), "SIGKILL"); // the running cell dies; setsid'd runners survive (F3)
  } catch {}
  rmSync(join(sessDir(name), "exec.lock"), { force: true });
  out(`[colab] Kernel restarted for session '${name}'.`);
  return 0;
}

function cmdLs(p: Parsed): number {
  sweep();
  const name = p.session ?? "";
  if (!active(name)) return notFound(name), 1;
  const dir = mapRemote(name, p.positional[0] ?? "/content");
  if (!existsSync(dir)) return err(`[colab] File or directory not found: ${p.positional[0]}`), 1;
  for (const n of readdirSync(dir).sort()) out(n);
  return 0;
}

async function main(): Promise<number> {
  if (!STATE) return err("fake colab: FAKE_COLAB_STATE is not set"), 2;
  mkdirSync(STATE, { recursive: true });
  const argv = process.argv.slice(2);
  appendFileSync(join(STATE, "calls.log"), argv.join(" ") + "\n");
  const p = parse(stripGlobals(argv).rest);
  switch (p.sub) {
    case "version": return out("colab 0.7.4"), 0;
    case "sessions": return cmdSessions();
    case "usage": return cmdUsage();
    case "status": return cmdStatus(p);
    case "new": return cmdNew(p);
    case "exec": return cmdExec(p);
    case "upload": return cmdUpload(p);
    case "download": return cmdDownload(p);
    case "stop": return cmdStop(p);
    case "restart-kernel": return cmdRestartKernel(p);
    case "ls": return cmdLs(p);
    default: return err(`fake colab: unsupported command '${p.sub}'`), 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
