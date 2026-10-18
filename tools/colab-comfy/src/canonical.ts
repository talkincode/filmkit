// Canonical JSON + sha256 for colab-comfy cache keys and records.
// Deliberately NOT imported from filmkit's src/hash.ts: the helper is a
// standalone tool (PLAN §4.1) and its key format must not change just because
// filmkit's own hashing does.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** JSON with sorted object keys and no whitespace. Rejects values JSON cannot represent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Same key order as canonicalJson, but with fixed 2-space indentation and a trailing newline: the byte format of
 * run records (src/record.ts). Deterministic by construction: no timestamps, no insertion-order dependence.
 */
export function canonicalJsonPretty(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) throw new Error(`canonicalJson: undefined at key "${k}"`);
      out[k] = sortKeys(v);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}
