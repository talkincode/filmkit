// Subprocess execution. All external commands (ffmpeg, ffprobe, Profile
// invocations) go through here so failures map to filmkit error codes in one
// place and tests can see exactly what was run.

import { spawnSync } from "node:child_process";
import { FilmkitError, missingDependency, toolFailure, type ErrorDetail } from "./errors.ts";
import type { ExitClass } from "./types.ts";

export interface ExecResult {
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  /** Extra environment; the parent environment is always inherited. */
  env?: Record<string, string>;
  /** Passed as stdin. */
  input?: string;
}

/** Run a command and return its result; never throws for a non-zero exit. */
export function exec(argv: string[], opts: ExecOptions): ExecResult {
  const [cmd, ...args] = argv;
  if (!cmd) throw new FilmkitError(toolFailure("empty argv"));
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new FilmkitError(missingDependency(`command not found: ${cmd}`, { hint: `install ${cmd} or fix PATH` }));
  }
  if (r.error) throw new FilmkitError(toolFailure(`${cmd} failed to start: ${r.error.message}`));
  return { argv, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function isOnPath(binary: string): boolean {
  return Bun.which(binary) !== null;
}

/** Map a tool exit status through a Profile's exitCodes table (spec §3.1). */
export function classifyExit(status: number | null, table: Record<string, ExitClass> | undefined): ExitClass {
  if (status === 0) return table?.["0"] ?? "ok";
  if (status === null) return "tool-failure";
  return table?.[String(status)] ?? "tool-failure";
}

/** Turn a failed ExecResult into an ErrorDetail carrying the tail of stderr. */
export function execFailure(r: ExecResult, cls: Exclude<ExitClass, "ok">, context: string): ErrorDetail {
  const tail = r.stderr.trim().split("\n").slice(-12).join("\n");
  return {
    code: cls,
    message: `${context}: ${r.argv[0]} exited with ${r.status}`,
    hint: tail ? `stderr:\n${tail}` : undefined,
  };
}
