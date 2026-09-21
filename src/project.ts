// `analyze()` is the shared front half of validate/plan/run/build/status:
// load the film, observe produces, order the graph, derive the timeline, run
// the checks that need resolved durations, and collect referenced files that
// are not in place yet.
//
// Missing referenced files are deliberately NOT fatal here: `plan` must be
// able to tell a fresh (e.g. freshly imported) project what to produce, and
// `validate`/`build` turn them into errors themselves.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCollector, FilmkitError, invalid, type ErrorDetail } from "./errors.ts";
import { classifyExit, exec, execFailure } from "./exec.ts";
import { at, type LoadedFilm, type Node, loadFilm } from "./film.ts";
import { downstreamOf, topoOrder } from "./graph.ts";
import { readLock } from "./lock.ts";
import { checkExactTrack, exactTracks } from "./cues.ts";
import { observe, type ProjectState } from "./state.ts";
import { expandTemplate } from "./template.ts";
import { deriveTimeline, type DerivedTimeline } from "./timeline.ts";
import { isGeneratedAsset } from "./types.ts";
import { formatFieldPath } from "./yaml.ts";
import { sha256File } from "./hash.ts";

/** A file the film references (static asset, tool document, cue file) that is not in place yet. */
export interface MissingFile {
  /** Project-relative path as written in the film. */
  path: string;
  /** Field that references it. */
  field: string;
  /** Ids of the nodes/tracks that need it (empty when nothing but the declaration uses it). */
  usedBy: string[];
}

export interface Analysis {
  loaded: LoadedFilm;
  state: ProjectState;
  /** Topological order of producible nodes. */
  order: Node[];
  timeline: DerivedTimeline;
  filmSha256: string;
  /** Nodes whose output must be rebuilt because an input is not ready. */
  blocked: Set<string>;
  missingFiles: MissingFile[];
}

export interface AnalyzeOptions {
  /** Run each cli task's `validate` template (spec §3.3). Default true. */
  delegate?: boolean;
}

export function analyze(filmPath: string, opts: AnalyzeOptions = {}): Analysis {
  const loaded = loadFilm(filmPath);
  const missingFiles = collectMissingFiles(loaded);
  const missingNodeIds = new Set(missingFiles.flatMap((m) => m.usedBy));

  const lock = readLock(loaded.dir);
  const state = observe(loaded, lock);
  const errors = new ErrorCollector();
  const order = topoOrder(loaded, errors);
  errors.throwIfAny();
  const timeline = deriveTimeline(loaded, state, errors);
  checkExactTracks(loaded, timeline, errors);
  // A node whose referenced files are missing cannot be validated by its tool yet;
  // `plan` reports the files instead.
  const delegable = order.filter((n) => !missingNodeIds.has(n.id));
  if (opts.delegate !== false) delegateValidation(loaded, delegable, errors);
  errors.throwIfAny();

  const blocked = new Set<string>();
  for (const n of order) {
    if (state.nodes.get(n.id)!.status !== "ready") for (const d of downstreamOf(order, n.id)) blocked.add(d);
  }
  return { loaded, state, order, timeline, filmSha256: sha256File(resolve(filmPath)), blocked, missingFiles };
}

/** Static assets and `./`-prefixed params must exist; report, do not throw (see the header note). */
function collectMissingFiles(loaded: LoadedFilm): MissingFile[] {
  const { film, dir } = loaded;
  const out: MissingFile[] = [];
  const usedBy = (id: string): string[] => {
    const users: string[] = [];
    for (const [assetId, asset] of Object.entries(film.assets)) if (isGeneratedAsset(asset) && asset.inputs.includes(id)) users.push(assetId);
    for (const scene of film.scenes) if (scene.inputs.includes(id)) users.push(scene.id);
    for (const t of film.timeline.tracks) if (t.kind !== "subtitles" && t.asset === id) users.push(`track:${t.id}`);
    return [...new Set(users)];
  };
  for (const [id, a] of Object.entries(film.assets)) {
    if (isGeneratedAsset(a) || /^https?:\/\//.test(a.uri)) continue;
    if (!existsSync(resolve(dir, a.uri))) out.push({ path: a.uri, field: `assets.${id}.uri`, usedBy: usedBy(id) });
  }
  const nodeParams = [
    ...Object.entries(film.assets).flatMap(([id, a]) =>
      isGeneratedAsset(a) ? [{ id, params: a.impl.params, field: ["assets", id, "impl", "params"] as (string | number)[] }] : [],
    ),
    ...film.scenes.map((s, i) => ({ id: s.id, params: s.impl.params, field: ["scenes", i, "impl", "params"] as (string | number)[] })),
  ];
  for (const n of nodeParams) {
    for (const [k, v] of Object.entries(n.params)) {
      if (typeof v === "string" && (v.startsWith("./") || v.startsWith("../")) && !existsSync(resolve(dir, v))) {
        out.push({ path: v, field: formatFieldPath([...n.field, k]), usedBy: [n.id] });
      }
    }
  }
  // A cue file is an input of the `fit: exact` track that declares it.
  film.timeline.tracks.forEach((t, i) => {
    if (t.kind !== "audio" || !t.cues) return;
    if (!existsSync(resolve(dir, t.cues))) out.push({ path: t.cues, field: `timeline.tracks[${i}].cues`, usedBy: [`track:${t.id}`] });
  });
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(`${m.field}|${m.path}`) ? false : (seen.add(`${m.field}|${m.path}`), true)));
}

/** Turn missing files into errors; `validate` and `build` call this, `plan` and `status` do not. */
export function requireFilesPlaced(a: Analysis): ErrorDetail[] {
  return a.missingFiles.map((m) =>
    invalid(`referenced file is not in place: ${m.path}`, {
      field: m.field,
      hint: m.usedBy.length ? `needed by: ${m.usedBy.join(", ")}` : "declared but not used by any node or track",
    }),
  );
}

function checkExactTracks(loaded: LoadedFilm, timeline: DerivedTimeline, errors: ErrorCollector): void {
  // Estimated durations would make the cut points guesses; the check runs once the picture is real.
  if (timeline.scenes.some((p) => p.estimated)) return;
  for (const spec of exactTracks(loaded.film, timeline.total)) {
    if (!existsSync(resolve(loaded.dir, spec.cuesPath))) continue; // not in place yet: `plan` reports it
    for (const e of checkExactTrack(spec, timeline, loaded.dir)) errors.add(e);
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
