// filmkit.lock.yaml: written by status/run/build, never by hand (spec §4).

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { FilmkitError, io } from "./errors.ts";
import { validateAgainstSchema } from "./schema.ts";
import { API_VERSION, type Lock } from "./types.ts";
import { loadYamlFile } from "./yaml.ts";

export const LOCK_FILENAME = "filmkit.lock.yaml";

export function lockPath(filmDir: string): string {
  return join(filmDir, LOCK_FILENAME);
}

/** Returns undefined when no lock exists yet. A malformed lock is an error, not silently ignored. */
export function readLock(filmDir: string): Lock | undefined {
  const path = lockPath(filmDir);
  if (!existsSync(path)) return undefined;
  const src = loadYamlFile(path);
  validateAgainstSchema("lock", src);
  return src.value as Lock;
}

/** Atomic write: serialize to a sibling temp file, then rename over the target. */
export function writeLock(filmDir: string, lock: Lock): void {
  const path = lockPath(filmDir);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, stringify(lock, { lineWidth: 0 }), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    throw new FilmkitError(io(`cannot write ${LOCK_FILENAME}: ${(err as Error).message}`));
  }
}

export function emptyLock(filmPath: string, filmSha: string): Lock {
  return { apiVersion: API_VERSION, kind: "Lock", film: { path: filmPath, sha256: filmSha }, nodes: {}, timeline: { total: 0, scenes: [] } };
}
