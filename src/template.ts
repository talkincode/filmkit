// How a Profile task becomes a process invocation (docs/spec.md §3.4).
//
// Two decisions live here, in one place, because both `validate` (delegated
// commands) and `run` must agree on them:
//   1. the working directory (`tasks[].cwd`), and
//   2. whether file placeholders are film-dir-relative or absolute.
//
// The rule: declaring a `cwd` means the tool no longer runs in the film
// directory, so every path filmkit hands over — `${produces.*}`, `${inputs.*}`
// and `./`-prefixed `params` — is expanded to an absolute path. Without a
// `cwd`, paths stay relative to the film directory, exactly as written.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { invalid, type ErrorDetail } from "./errors.ts";
import { inputPath, type LoadedFilm, type Node } from "./film.ts";
import type { ProfileTask } from "./types.ts";
import { expandArgv } from "./vars.ts";

export interface TaskCommand {
  argv: string[];
  /** Absolute working directory for the process. */
  cwd: string;
  /** A file placeholder in the argv only resolves against this dir when it is the film dir. */
  errors: ErrorDetail[];
}

/** Build the placeholder table for one node. */
export function templateTable(
  loaded: LoadedFilm,
  node: Node,
  opts: { absolutePaths: boolean },
): Record<string, string | string[] | undefined> {
  const toPath = (p: string | undefined): string | undefined => {
    if (p === undefined) return undefined;
    if (!opts.absolutePaths) return p;
    if (isAbsolute(p) || /^https?:\/\//.test(p)) return p;
    return normalize(resolve(loaded.dir, p));
  };
  const table: Record<string, string | string[] | undefined> = {
    "node.id": node.id,
    "film.dir": loaded.dir,
    "output.width": String(loaded.film.output.video.width),
    "output.height": String(loaded.film.output.video.height),
    "output.fps": String(loaded.film.output.video.fps),
  };
  for (const [k, v] of Object.entries(node.impl.params)) {
    if (typeof v === "string") {
      table[`params.${k}`] = opts.absolutePaths && /^\.\.?\//.test(v) ? toPath(v) : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      table[`params.${k}`] = String(v);
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      table[`params.${k}`] = opts.absolutePaths ? (v as string[]).map((x) => (/^\.\.?\//.test(x) ? toPath(x)! : x)) : (v as string[]);
    }
  }
  for (const [type, p] of Object.entries(node.produces)) table[`produces.${type}`] = toPath(p);
  for (const id of node.inputs) table[`inputs.${id}`] = toPath(inputPath(loaded.film, id));
  return table;
}

export interface ResolveOptions {
  /** Field path prefix used in error messages. */
  field: string;
}

/**
 * Resolve a task's `cwd` template against the project directory. Returns the
 * absolute directory, or an error when the template escapes the project or the
 * directory is not there.
 */
export function resolveTaskCwd(
  loaded: LoadedFilm,
  node: Node,
  task: ProfileTask,
  field: string,
): { cwd: string; relative?: string; missing: boolean; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  if (!task.cwd) return { cwd: loaded.dir, relative: undefined, missing: false, errors };
  const table = templateTable(loaded, node, { absolutePaths: false });
  const { argv, errors: expandErrors } = expandArgv([task.cwd], table, `${field}.cwd`);
  errors.push(...expandErrors);
  if (errors.length) return { cwd: loaded.dir, relative: undefined, missing: false, errors };
  const raw = argv[0]!;
  const abs = isAbsolute(raw) ? normalize(raw) : normalize(resolve(loaded.dir, raw));
  const inside = abs === loaded.dir || abs.startsWith(loaded.dir.endsWith("/") ? loaded.dir : loaded.dir + "/");
  if (!inside) {
    // Structural: it can never become valid, so it is an error everywhere.
    errors.push(invalid(`cwd "${raw}" escapes the project directory`, { field: `${field}.cwd` }));
    return { cwd: loaded.dir, relative: raw, missing: false, errors };
  }
  const missing = !existsSync(abs) || !statSync(abs).isDirectory();
  return { cwd: abs, relative: raw, missing, errors };
}

/** Expand a task's argv template, honoring its `cwd` (spec §3.4). */
export function taskCommand(
  loaded: LoadedFilm,
  node: Node,
  task: ProfileTask,
  template: string[],
  field: string,
): TaskCommand {
  const resolved = resolveTaskCwd(loaded, node, task, field);
  const cwdErrors = [...resolved.errors];
  if (resolved.missing) {
    // `plan` reports it; here we are about to run something, so it is fatal.
    cwdErrors.push(invalid(`cwd "${resolved.relative}" is not a directory`, { field: `${field}.cwd`, hint: `expected ${resolved.cwd}` }));
  }
  const cwd = resolved.cwd;
  const declared = Object.keys((task.paramsSchema as { properties?: Record<string, unknown> }).properties ?? {});
  const { argv, errors } = expandArgv(template, templateTable(loaded, node, { absolutePaths: Boolean(task.cwd) }), field, declared);
  return { argv, cwd, errors: [...cwdErrors, ...errors] };
}
