// One way to run an external program: argv (never a shell string), captured output,
// an explicit timeout, and failures that say which program and what it printed.

import { spawn, type ChildProcess } from "node:child_process";
import { fail, missingDependency, toolFailure } from "./errors.ts";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Milliseconds. Default 10 minutes. */
  timeout?: number;
  /** Stdin text. */
  input?: string;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const active = new Set<ChildProcess>();

/** Stop every program this process started (an interrupted render must not leave Blender or Chrome running). */
export function killChildren(): void {
  for (const child of active) child.kill("SIGKILL");
  active.clear();
}

/** Runs argv; resolves with the result whatever the exit status (callers decide), rejects only if it cannot start or times out. */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    active.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RunError(`${cmd} did not finish within ${Math.round((opts.timeout ?? 600_000) / 1000)}s`, "timeout"));
    }, opts.timeout ?? 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      active.delete(child);
      reject(new RunError(`cannot start ${cmd}: ${err.message}`, (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "start"));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ status: status ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

export class RunError extends Error {
  constructor(message: string, readonly kind: "missing" | "timeout" | "start") {
    super(message);
  }
}

/** Last lines of a program's output, for error hints (no absolute-path scrubbing: this is the user's own machine). */
export function tail(text: string, lines = 12): string {
  const all = text.trim().split("\n");
  return all.slice(-lines).join("\n");
}

/** Run and require exit 0; anything else is a tool failure carrying the program's own words. */
export async function runOk(argv: string[], what: string, opts: RunOptions = {}): Promise<RunResult> {
  let r: RunResult;
  try {
    r = await run(argv, opts);
  } catch (err) {
    if (err instanceof RunError && err.kind === "missing") return fail(missingDependency(`${argv[0]} is not installed or not on PATH (${what})`));
    return fail(toolFailure(`${what}: ${(err as Error).message}`));
  }
  if (r.status !== 0) {
    return fail(toolFailure(`${what} failed (exit ${r.status})`, { hint: tail(`${r.stderr}\n${r.stdout}`) }));
  }
  return r;
}
