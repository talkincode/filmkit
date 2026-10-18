// Project-local session state under <film dir>/.colab-comfy/ (PLAN §5.6):
//   ledger.jsonl            one line per finished session (append-only)
//   sessions/<name>.json    last status + redacted transcript of that session
//   active.json             exists ONLY while a session might be alive (written BEFORE `colab new`)
//   batch.lock              one batch per project (O_EXCL + pid liveness)
// Everything written here has passed through redact() (callers pass already-redacted text).

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, writeFileAtomic } from "./cache.ts";
import { ColabComfyError, EXIT } from "./errors.ts";

export const stateDir = (baseDir: string): string => join(baseDir, STATE_DIR);
export const activePath = (dir: string): string => join(dir, "active.json");
export const ledgerPath = (dir: string): string => join(dir, "ledger.jsonl");
export const sessionFilePath = (dir: string, name: string): string => join(dir, "sessions", `${name}.json`);
export const lockPath = (dir: string): string => join(dir, "batch.lock");

/** `kill(pid, 0)`: EPERM means the process exists but is not ours; ESRCH (or a bad pid) means dead. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ActiveRecord {
  name: string;
  /** The helper process that owns the session. */
  pid: number;
  /** Epoch seconds: after this the host aborts; the guard stops everything at deadline + 300 s. */
  deadline: number;
  phase: "opening" | "uploading" | "running" | "stopping";
  film: string;
  startedAt: string;
  guardPid?: number;
}

/** Callers pass the state dir (`<film dir>/.colab-comfy`), not the film dir. */
export function readActive(dir: string): ActiveRecord | null {
  try {
    const v = JSON.parse(readFileSync(activePath(dir), "utf8")) as ActiveRecord;
    return typeof v?.name === "string" && typeof v.pid === "number" ? v : null;
  } catch {
    return null;
  }
}

export function writeActive(dir: string, rec: ActiveRecord): void {
  writeFileAtomic(activePath(dir), JSON.stringify(rec, null, 2) + "\n");
}

/** Remove active.json; with `onlyName` it is left alone when it records a different session. */
export function removeActive(dir: string, onlyName?: string): boolean {
  const cur = readActive(dir);
  if (onlyName !== undefined && cur && cur.name !== onlyName) return false;
  rmSync(activePath(dir), { force: true });
  return true;
}

export function appendLedger(dir: string, entry: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerPath(dir), JSON.stringify(entry) + "\n");
}

export function readLedger(dir: string): Record<string, unknown>[] {
  const p = ledgerPath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function writeSessionFile(dir: string, name: string, doc: unknown): void {
  writeFileAtomic(sessionFilePath(dir, name), JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Take the per-project batch lock. A lock whose recorded pid is dead is stale and is taken over
 * (remove + O_EXCL create; of two racing takers only one wins the create). Returns the release function.
 */
export function acquireBatchLock(dir: string, pid: number = process.pid): () => void {
  mkdirSync(dir, { recursive: true });
  const path = lockPath(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          const cur = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
          if (cur.pid === pid) rmSync(path, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let owner: number | undefined;
    try {
      owner = (JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid;
    } catch {
      owner = undefined; // unreadable/half-written lock: treated as stale
    }
    if (owner !== undefined && owner !== pid && pidAlive(owner)) {
      throw new ColabComfyError(EXIT.toolFailure, [
        { code: "batch-locked", message: `another colab-comfy batch is running in this project (pid ${owner})`, hint: `wait for it, or remove ${path} if that process is gone` },
      ]);
    }
    rmSync(path, { force: true });
  }
  throw new ColabComfyError(EXIT.toolFailure, [{ code: "batch-locked", message: `could not take ${path}` }]);
}
