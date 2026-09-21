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
 * Hash of `impl.params` plus the content of every `./`-prefixed path it contains.
 *
 * Files are hashed by content, which is what chains one node to another: a
 * transcription that reads `./build/voice/s1.wav` goes stale when the narration
 * is re-rendered. Directories are walked recursively, but **every declared
 * produce is skipped** — otherwise a tool handed a directory would go stale
 * whenever any sibling node writes into it, and a tool handed a directory it
 * writes into would invalidate itself. Produces are already tracked by the lock,
 * so nothing is lost.
 */
export function paramsHash(params: unknown, dir: string, opts: { produces?: string[] } = {}): string {
  const dirExclude = new Set((opts.produces ?? []).map((p) => resolve(dir, p)));
  return sha256Text(canonicalJson(enrich(params, dir, dirExclude)));
}

function enrich(value: unknown, dir: string, dirExclude: Set<string>): unknown {
  if (typeof value === "string") {
    if (!/^\.\.?\//.test(value)) return value;
    return { $path: value, $content: hashPath(resolve(dir, value), dirExclude) };
  }
  if (Array.isArray(value)) return value.map((v) => enrich(v, dir, dirExclude));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = enrich(v, dir, dirExclude);
    return out;
  }
  return value;
}

/** `file:<sha>` / `dir:<sha>` / `missing` — the marker makes a later creation change the hash. */
export function hashPath(abs: string, dirExclude: Set<string> = new Set()): string {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return "missing";
  }
  if (st.isDirectory()) return `dir:${hashDirectory(abs, dirExclude)}`;
  if (st.isFile()) return `file:${sha256File(abs)}`;
  return "other";
}

export function hashDirectory(abs: string, dirExclude: Set<string> = new Set()): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    const names = readdirSync(current, { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const child = join(current, name);
      // A declared produce is skipped entirely (not just content-hashed away):
      // its presence in the directory must not move the hash either, or a
      // sibling node writing into this directory would invalidate the node.
      if (dirExclude.has(child)) continue;
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
