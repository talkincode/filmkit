// `analyze()` is the shared front half of validate/plan/run/build/status:
// load the film, check referenced files, observe produces, order the graph and
// derive the timeline. Each command then does its own thing with the result.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCollector, FilmkitError, invalid } from "./errors.ts";
import { classifyExit, exec, execFailure } from "./exec.ts";
import { at, isUrl, type LoadedFilm, type Node, loadFilm } from "./film.ts";
import { isGeneratedAsset } from "./types.ts";
import { downstreamOf, topoOrder } from "./graph.ts";
import { readLock } from "./lock.ts";
import { observe, type ProjectState } from "./state.ts";
import { expandTemplate } from "./template.ts";
import { deriveTimeline, type DerivedTimeline } from "./timeline.ts";
import { formatFieldPath } from "./yaml.ts";
import { sha256File } from "./hash.ts";

export interface Analysis {
  loaded: LoadedFilm;
  state: ProjectState;
  /** Topological order of producible nodes. */
  order: Node[];
  timeline: DerivedTimeline;
  filmSha256: string;
  /** Ids whose upstream input changed or is not ready; they must be rebuilt after it. */
  blocked: Set<string>;
}

export interface AnalyzeOptions {
  /** Run each cli task's `validate` template (spec §3.3). Default true. */
  delegate?: boolean;
}

export function analyze(filmPath: string, opts: AnalyzeOptions = {}): Analysis {
  const loaded = loadFilm(filmPath);
  const errors = new ErrorCollector();
  checkReferencedFiles(loaded, errors);
  errors.throwIfAny();

  const lock = readLock(loaded.dir);
  const state = observe(loaded, lock);
  const order = topoOrder(loaded, errors);
  errors.throwIfAny();
  const timeline = deriveTimeline(loaded, state, errors);
  if (opts.delegate !== false) delegateValidation(loaded, order, errors);
  errors.throwIfAny();

  const blocked = new Set<string>();
  for (const n of order) {
    const s = state.nodes.get(n.id)!;
    if (s.status !== "ready") for (const d of downstreamOf(order, n.id)) blocked.add(d);
  }
  return { loaded, state, order, timeline, filmSha256: sha256File(resolve(filmPath)), blocked };
}

/** Static asset files and `./`-prefixed params must exist (spec §1.5, §1.7.2). */
function checkReferencedFiles(loaded: LoadedFilm, errors: ErrorCollector): void {
  const { film, dir, src } = loaded;
  for (const [id, a] of Object.entries(film.assets)) {
    if (isGeneratedAsset(a) || isUrl(a.uri)) continue;
    if (!existsSync(resolve(dir, a.uri))) errors.add(at(invalid(`asset file not found: ${a.uri}`, { field: `assets.${id}.uri` }), src));
  }
  const nodes = [
    ...Object.entries(film.assets).flatMap(([id, a]) => (isGeneratedAsset(a) ? [{ params: a.impl.params, field: ["assets", id, "impl", "params"] as (string | number)[] }] : [])),
    ...film.scenes.map((s, i) => ({ params: s.impl.params, field: ["scenes", i, "impl", "params"] as (string | number)[] })),
  ];
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.params)) {
      if (typeof v === "string" && (v.startsWith("./") || v.startsWith("../")) && !existsSync(resolve(dir, v))) {
        errors.add(at(invalid(`referenced file not found: ${v}`, { field: formatFieldPath([...n.field, k]) }), src));
      }
    }
  }
}

function delegateValidation(loaded: LoadedFilm, order: Node[], errors: ErrorCollector): void {
  for (const node of order) {
    const prof = loaded.profiles.get(node.impl.profile)!;
    const task = prof.profile.tasks[node.impl.task]!;
    if (prof.profile.runtime.type !== "cli" || !task.validate) continue;
    const field = `${formatFieldPath(node.field)}.impl`;
    const { argv, errors: tplErrors } = expandTemplate(loaded, node, task.validate, `${prof.profile.metadata.name}.tasks.${node.impl.task}.validate`);
    if (tplErrors.length) { tplErrors.forEach((e) => errors.add(at({ ...e, field }, loaded.src))); continue; }
    let r;
    try {
      r = exec(argv, { cwd: loaded.dir });
    } catch (err) {
      if (err instanceof FilmkitError) { err.errors.forEach((e) => errors.add(e)); continue; }
      throw err;
    }
    const cls = classifyExit(r.status, prof.profile.runtime.exitCodes);
    if (cls !== "ok") {
      const detail = execFailure(r, cls, `${node.id}: ${prof.profile.metadata.name} validate`);
      errors.add(at({ ...detail, code: "invalid-input", field }, loaded.src));
    }
  }
}
