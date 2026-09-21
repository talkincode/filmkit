// Content hashing for the lock file. Canonical JSON (sorted keys) so the same
// params always hash the same regardless of YAML key order, plus the content of
// every file the params reference — otherwise an edit to a tool's own document
// (a scorekit scene, a Remotion project) would leave the node looking ready.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

/** Directory names that are tooling rather than source; their content never feeds a hash. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Hash of `impl.params` plus the content of every `./`-prefixed path it
 * contains (files, or directories walked recursively in a stable order).
 * Skipped: `node_modules` and `.git` inside referenced directories.
 */
export function paramsHash(params: unknown, dir: string): string {
  return sha256Text(canonicalJson(enrich(params, dir)));
}

function enrich(value: unknown, dir: string): unknown {
  if (typeof value === "string") {
    if (!/^\.\.?\//.test(value)) return value;
    return { $path: value, $content: hashPath(resolve(dir, value)) };
  }
  if (Array.isArray(value)) return value.map((v) => enrich(v, dir));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = enrich(v, dir);
    return out;
  }
  return value;
}

/** `file:<sha>` / `dir:<sha>` / `missing` — the marker makes a later creation change the hash. */
export function hashPath(abs: string): string {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return "missing";
  }
  if (st.isDirectory()) return `dir:${hashDirectory(abs)}`;
  if (st.isFile()) return `file:${sha256File(abs)}`;
  return "other";
}

export function hashDirectory(abs: string): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    const names = readdirSync(current, { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const child = join(current, name);
      const rel = relative(abs, child).split("\\").join("/");
      let st;
      try {
        st = statSync(child);
      } catch {
        entries.push(`${rel}:gone`);
        continue;
      }
      if (st.isDirectory()) walk(child);
      else if (st.isFile()) entries.push(`${rel}:${sha256File(child)}`);
      else entries.push(`${rel}:other`);
    }
  };
  walk(abs);
  return sha256Text(entries.join("\n"));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sameFilePath(a: string, b: string): boolean {
  return normalize(isAbsolute(a) ? a : resolve(a)) === normalize(isAbsolute(b) ? b : resolve(b));
}
