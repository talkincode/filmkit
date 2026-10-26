// The three user-facing flows, each a thin composition of the same pieces:
//   convert  bundle file -> filmkit.yaml            (offline; lists the files still missing)
//   fetch    bundle file -> the files it needs      (network; bytes only)
//   pull     vflow       -> bundle + files + film   (network; = export, fetch, convert)
//
// Write order in `pull` is chosen so a failure leaves the project as it was:
// the film is validated in memory first, every download is verified before it
// lands, and the bundle record and the film (the file people look at) are
// written last, each by temp file + rename.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FilmkitError } from "../../../src/errors.ts";
import { loadFilm } from "../../../src/film.ts";
import { parseBundle } from "./bundle.ts";
import { type Client } from "./client.ts";
import { type Conversion, convertBundle } from "./convert.ts";
import { fail, io } from "./errors.ts";
import { fetchFiles, type FetchResult } from "./files.ts";

export interface Report {
  out?: string;
  bundle?: string;
  scenes: number;
  assets: number;
  downloaded: number;
  /** Files already in place with the right content. */
  present: number;
  warnings: string[];
  ignored: string[];
  /** Files the film references that are not on disk (empty after a successful pull). */
  missingFiles: string[];
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    fail(io(`cannot write ${path}: ${(err as Error).message}`));
  }
}

/** Prove the generated text is a legal film before anything is written for real. */
function assertLegalFilm(yaml: string): void {
  const dir = mkdtempSync(join(tmpdir(), "vflow-pull-"));
  try {
    const path = join(dir, "filmkit.yaml");
    writeFileSync(path, yaml, "utf8");
    loadFilm(path);
  } catch (err) {
    if (err instanceof FilmkitError) {
      fail(...err.errors.map((e) => ({ code: e.code, message: `the converted film is not legal for filmkit: ${e.message}`, ...(e.field ? { field: e.field } : {}), ...(e.hint ? { hint: e.hint } : {}) })));
    }
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refuseOverwrite(out: string, force: boolean): void {
  if (existsSync(out) && !force) {
    fail(io(`refusing to overwrite ${out}`, { hint: "pass --force to replace it (the existing film is not read first)" }));
  }
}

function missingOf(conversion: Conversion, dir: string): string[] {
  const missing = new Set<string>();
  for (const item of conversion.fetch) for (const t of item.targets) if (!existsSync(resolve(dir, t))) missing.add(t);
  return [...missing];
}

function readBundleFile(path: string) {
  if (!existsSync(path)) fail(io(`file not found: ${path}`));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return fail(io(`cannot read ${path}: ${(err as Error).message}`));
  }
  return parseBundle(text, path);
}

const report = (c: Conversion, extra: Partial<Report>, dir: string): Report => ({
  scenes: c.scenes,
  assets: c.assets,
  downloaded: 0,
  present: 0,
  warnings: c.warnings,
  ignored: c.ignored,
  missingFiles: missingOf(c, dir),
  ...extra,
});

const counts = (r: FetchResult): Pick<Report, "downloaded" | "present"> => ({ downloaded: r.downloaded.length, present: r.present.length });

export function writeNewFile(path: string, text: string, force = false): void {
  const out = resolve(path);
  refuseOverwrite(out, force);
  writeAtomic(out, text);
}

export function convertFile(opts: { bundlePath: string; out: string; force: boolean }): Report {
  const out = resolve(opts.out);
  refuseOverwrite(out, opts.force);
  const bundle = readBundleFile(opts.bundlePath);
  const conversion = convertBundle(bundle, `${bundle.composition.project}/${bundle.composition.id}${bundle.revision !== undefined ? `@${bundle.revision}` : ""}`);
  assertLegalFilm(conversion.yaml);
  writeAtomic(out, conversion.yaml);
  return report(conversion, { out: opts.out }, dirname(out));
}

export async function fetchFromFile(opts: { bundlePath: string; client: Client; dir: string; force: boolean }): Promise<Report> {
  const bundle = readBundleFile(opts.bundlePath);
  const conversion = convertBundle(bundle, "fetch");
  const dir = resolve(opts.dir);
  const result = await fetchFiles({ client: opts.client, project: bundle.composition.project, items: conversion.fetch, dir, force: opts.force });
  return report(conversion, { bundle: opts.bundlePath, ...counts(result) }, dir);
}

export async function pull(opts: { client: Client; project: string; composition: string; revision?: number; out: string; force: boolean }): Promise<Report> {
  const out = resolve(opts.out);
  const dir = dirname(out);
  refuseOverwrite(out, opts.force); // before any request

  const exported = await opts.client.exportBundle(opts.project, opts.composition, opts.revision);
  const bundle = parseBundle(exported, `${opts.project}/${opts.composition}`);
  const rev = bundle.revision !== undefined ? String(bundle.revision) : "head";
  const conversion = convertBundle(bundle, `${bundle.composition.project}/${bundle.composition.id}@${rev}`);
  assertLegalFilm(conversion.yaml); // still nothing on disk

  const bundlePath = join(dir, "vflow", `${bundle.composition.id.replace(/[^A-Za-z0-9._-]+/g, "_")}@${rev}.bundle.json`);
  const result = await fetchFiles({
    client: opts.client, project: bundle.composition.project, items: conversion.fetch, dir, force: opts.force,
    writes: [
      { target: bundlePath, text: `${JSON.stringify(sortKeys(bundleForRecord(exported)), null, 2)}\n` },
      { target: out, text: conversion.yaml },
    ],
  });
  return report(conversion, { out: opts.out, bundle: bundlePath, ...counts(result) }, dir);
}

/** The record keeps the bundle as vflow sent it (minus the REST wrapper's duplicate text), key-sorted so the file is stable. */
function bundleForRecord(exported: unknown): unknown {
  const o = exported as { bundle?: unknown; composition?: unknown };
  return o && typeof o === "object" && o.bundle !== undefined && o.composition === undefined ? o.bundle : exported;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
