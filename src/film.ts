// Load `filmkit.yaml`: YAML -> schema -> ${vars} substitution -> defaults ->
// profile resolution -> structural semantic checks that need no filesystem or
// ffprobe. Anything that depends on which produces exist lives in state.ts /
// timeline.ts so the pure part stays testable with fixtures alone.

import { dirname, extname, isAbsolute, normalize, resolve } from "node:path";
import { ErrorCollector, FilmkitError, invalid, type ErrorDetail } from "./errors.ts";
import { resolveProfileRef, type LoadedProfile } from "./profile.ts";
import { validateAgainstSchema, validateParams } from "./schema.ts";
import {
  isGeneratedAsset,
  PRODUCE_PRIORITY,
  type Asset,
  type Film,
  type Impl,
  type Produces,
  type ProduceType,
  type AudioTrack,
  type OverlayTrack,
  type SubtitlesTrack,
  type Track,
} from "./types.ts";
import { substituteVars } from "./vars.ts";
import { formatFieldPath, loadYamlFile, positionOf, type PathSegment, type YamlSource } from "./yaml.ts";

export interface LoadedFilm {
  film: Film;
  src: YamlSource;
  /** Absolute project directory (where filmkit.yaml lives). */
  dir: string;
  /** Path of filmkit.yaml as given by the caller. */
  path: string;
  profiles: Map<string, LoadedProfile>;
}

/** A producible node: a scene or a generated asset (spec §1.5). */
export interface Node {
  id: string;
  kind: "scene" | "asset";
  impl: Impl;
  produces: Produces;
  inputs: string[];
  /** Field path prefix in filmkit.yaml, for error reporting. */
  field: PathSegment[];
}

export function loadFilm(path: string): LoadedFilm {
  const src = loadYamlFile(path);
  validateAgainstSchema("film", src);

  const raw = src.value as Record<string, unknown>;
  const vars = (raw.vars ?? {}) as Record<string, string | number | boolean>;
  const substituted = substituteVars(raw, vars);
  if (substituted.errors.length) {
    throw new FilmkitError(substituted.errors.map((e) => at(e, src)));
  }
  const film = applyDefaults(substituted.value as Record<string, unknown>);
  const dir = resolve(dirname(path));

  const errors = new ErrorCollector();
  const profiles = new Map<string, LoadedProfile>();
  film.profiles.forEach((p, i) => {
    const field = `profiles[${i}].ref`;
    if (p.source) {
      errors.add(at(invalid(`profiles[${i}].source is reserved and not implemented in v1alpha1`, { field: `profiles[${i}].source` }), src));
      return;
    }
    try {
      const loaded = resolveProfileRef(p.ref, dir, field);
      const name = loaded.profile.metadata.name;
      if (profiles.has(name)) {
        errors.add(at(invalid(`profile "${name}" is registered twice`, { field }), src));
        return;
      }
      profiles.set(name, loaded);
    } catch (err) {
      if (err instanceof FilmkitError) err.errors.forEach((e) => errors.add(at(e, src)));
      else throw err;
    }
  });

  const loaded: LoadedFilm = { film, src, dir, path, profiles };
  checkStructure(loaded, errors);
  errors.throwIfAny();
  return loaded;
}

/** Defaults from spec tables, applied explicitly so no reader has to know ajv's useDefaults. */
function applyDefaults(raw: Record<string, unknown>): Film {
  const f = structuredClone(raw) as unknown as Film & { output: Partial<Film["output"]> & Record<string, unknown> };
  f.vars ??= {};
  f.assets ??= {};
  const meta = f.metadata;
  const out = f.output as Film["output"];
  out.path ??= `./build/${meta.name}.${out.container}`;
  out.video.pixelFormat ??= "yuv420p";
  out.video.quality ??= 18;
  out.audio.bitrate ??= "192k";
  out.duration = { ...(out.duration ?? {}), tolerance: out.duration?.tolerance ?? 0.5 };
  out.fit ??= "contain";
  out.background ??= "black";
  for (const s of f.scenes) {
    s.durationPolicy ??= "auto";
    s.inputs ??= [];
    s.impl.params ??= {};
  }
  for (const a of Object.values(f.assets)) {
    if (isGeneratedAsset(a)) {
      a.inputs ??= [];
      a.impl.params ??= {};
    }
  }
  const tl = (f.timeline ?? {}) as Partial<Film["timeline"]>;
  f.timeline = {
    sequence: tl.sequence ?? f.scenes.map((s) => s.id),
    transition: { default: tl.transition?.default ?? { type: "cut" } },
    tracks: (tl.tracks ?? []).map((t) => trackDefaults(t)),
    ...(tl.chapters ? { chapters: tl.chapters } : {}),
  };
  return f;
}

/**
 * Fill in a track's documented defaults.
 *
 * The raw track is spread last on purpose: this function must never rebuild a
 * track field by field, because every field it forgets would silently vanish
 * (`source` on a subtitles track, `cues` on an audio track — both were real
 * bugs). Defaults fill gaps; whatever the film wrote wins.
 */
function trackDefaults(raw: Track): Track {
  const t = raw as Partial<Track> & { id: string; kind: Track["kind"] };
  switch (t.kind) {
    case "audio":
      return { fit: "loop", volume: 1, fadeIn: 0, fadeOut: 0, from: 0, to: "end", ...t } as AudioTrack;
    case "overlay":
      return { position: "top-right", margin: 32, opacity: 1, from: 0, to: "end", ...t } as OverlayTrack;
    case "subtitles":
      return { source: "scenes", mode: "sidecar", ...t } as SubtitlesTrack;
  }
}

export function nodesOf(film: Film): Node[] {
  const nodes: Node[] = [];
  Object.entries(film.assets).forEach(([id, a]) => {
    if (isGeneratedAsset(a)) nodes.push({ id, kind: "asset", impl: a.impl, produces: a.produces, inputs: a.inputs, field: ["assets", id] });
  });
  film.scenes.forEach((s, i) => {
    // A named audio asset is a dependency: the scene is blocked until it exists.
    const known = s.audio !== undefined && s.audio in film.assets;
    const inputs = known && s.audio && !s.inputs.includes(s.audio) ? [...s.inputs, s.audio] : s.inputs;
    nodes.push({ id: s.id, kind: "scene", impl: s.impl, produces: s.produces, inputs, field: ["scenes", i] });
  });
  // A `./`-prefixed param that another node produces is a dependency too: the
  // narration a TTS node writes, then a transcription node reads, and so on.
  const producedBy = new Map<string, string>();
  for (const node of nodes) for (const path of Object.values(node.produces)) producedBy.set(normalize(path), node.id);
  for (const node of nodes) {
    const fromParams = Object.values(node.impl.params)
      .filter((v): v is string => typeof v === "string" && /^\.\.?\//.test(v))
      .map((v) => producedBy.get(normalize(v)))
      .filter((id): id is string => id !== undefined && id !== node.id);
    for (const id of fromParams) if (!node.inputs.includes(id)) node.inputs = [...node.inputs, id];
  }
  return nodes;
}

export function primaryProduce(produces: Produces): { type: ProduceType; path: string } | undefined {
  for (const t of PRODUCE_PRIORITY) {
    const p = produces[t];
    if (p) return { type: t, path: p };
  }
  return undefined;
}

/** Path of the thing `${inputs.<id>}` refers to (spec §3.4). */
export function inputPath(film: Film, id: string): string | undefined {
  const asset = film.assets[id];
  if (asset) return isGeneratedAsset(asset) ? primaryProduce(asset.produces)?.path : asset.uri;
  const scene = film.scenes.find((s) => s.id === id);
  return scene ? primaryProduce(scene.produces)?.path : undefined;
}

export function isUrl(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

/** True when `p` (relative) stays inside the project directory. */
export function insideProject(dir: string, p: string): boolean {
  if (isAbsolute(p)) return false;
  const full = normalize(resolve(dir, p));
  return full === dir || full.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

const CONTAINER_VIDEO: Record<Film["output"]["container"], Film["output"]["video"]["codec"][]> = {
  mp4: ["h264", "hevc", "av1"],
  mov: ["h264", "hevc", "prores"],
  mkv: ["h264", "hevc", "vp9", "av1"],
  webm: ["vp9", "av1"],
};
const CONTAINER_AUDIO: Record<Film["output"]["container"], Film["output"]["audio"]["codec"][]> = {
  mp4: ["aac", "opus", "flac"],
  mov: ["aac", "pcm_s16le"],
  mkv: ["aac", "opus", "pcm_s16le", "flac"],
  webm: ["opus"],
};

function checkStructure(loaded: LoadedFilm, errors: ErrorCollector): void {
  const { film, src, dir, profiles } = loaded;
  const add = (path: PathSegment[], message: string, hint?: string) =>
    errors.add(at(invalid(message, { field: formatFieldPath(path), hint }), src));

  // --- identifiers share one namespace ---
  const ids = new Map<string, PathSegment[]>();
  Object.keys(film.assets).forEach((id) => ids.set(id, ["assets", id]));
  film.scenes.forEach((s, i) => {
    if (ids.has(s.id)) add(["scenes", i, "id"], `id "${s.id}" is already used by ${formatFieldPath(ids.get(s.id)!)}`);
    else ids.set(s.id, ["scenes", i]);
  });

  // --- output ---
  const out = film.output;
  const ext = extname(out.path).slice(1);
  if (ext !== out.container) add(["output", "path"], `extension ".${ext}" does not match container "${out.container}"`);
  if (!insideProject(dir, out.path)) add(["output", "path"], "output path must be a relative path inside the project");
  if (!CONTAINER_VIDEO[out.container].includes(out.video.codec)) {
    add(["output", "video", "codec"], `codec "${out.video.codec}" is not allowed in ${out.container}`, `allowed: ${CONTAINER_VIDEO[out.container].join(", ")}`);
  }
  if (!CONTAINER_AUDIO[out.container].includes(out.audio.codec)) {
    add(["output", "audio", "codec"], `codec "${out.audio.codec}" is not allowed in ${out.container}`, `allowed: ${CONTAINER_AUDIO[out.container].join(", ")}`);
  }

  // --- assets ---
  for (const [id, a] of Object.entries(film.assets)) {
    if (!isGeneratedAsset(a)) {
      if (isAbsolute(a.uri)) add(["assets", id, "uri"], "absolute paths are not allowed");
      else if (!isUrl(a.uri) && !insideProject(dir, a.uri)) add(["assets", id, "uri"], "path escapes the project directory");
    } else {
      const produced = kindToProduce(a.kind);
      if (produced && !a.produces[produced]) add(["assets", id, "produces"], `generated asset of kind "${a.kind}" must produce "${produced}"`);
    }
  }

  // --- nodes (scenes + generated assets) ---
  const producePaths = new Map<string, PathSegment[]>();
  for (const node of nodesOf(film)) {
    checkImpl(loaded, node, errors);
    for (const [type, p] of Object.entries(node.produces) as [ProduceType, string][]) {
      const field = [...node.field, "produces", type];
      if (!insideProject(dir, p)) add(field, "path escapes the project directory");
      const key = normalize(p);
      const prev = producePaths.get(key);
      if (prev) add(field, `path "${p}" is also produced by ${formatFieldPath(prev)}`);
      else producePaths.set(key, field);
    }
    node.inputs.forEach((inp, i) => {
      if (inp === node.id) add([...node.field, "inputs", i], "a node cannot be its own input");
      else if (!ids.has(inp)) add([...node.field, "inputs", i], `unknown input "${inp}"`);
    });
  }

  // --- scenes ---
  film.scenes.forEach((s, i) => {
    const field = (...rest: PathSegment[]) => ["scenes", i, ...rest];
    const hasMedia = Boolean(s.produces.video || s.produces.audio || s.audio);
    if (s.duration === undefined && (s.durationPolicy !== "auto" || !hasMedia)) {
      add(field("duration"), `duration is required when durationPolicy is "${s.durationPolicy}" or the scene produces neither video nor audio`);
    }
    if (s.audio && s.produces.audio) {
      add(field("audio"), "a scene cannot both produce its own audio and name an audio asset; drop one of them");
    }
    if (s.audio) {
      const asset = film.assets[s.audio];
      if (!asset) add(field("audio"), `unknown asset "${s.audio}"`);
      else if (asset.kind !== "audio") add(field("audio"), `asset "${s.audio}" is ${asset.kind}, a scene's audio needs kind: audio`);
    }
    if (s.audioMode === "keep" && (s.produces.audio || s.audio)) add(field("audioMode"), `audioMode "keep" contradicts the scene's own audio`);
    if (s.audioMode && !s.produces.video && !s.produces.audio && !s.audio) add(field("audioMode"), "audioMode has no effect without video or audio");
    const voice = s.intent?.narration?.voiceRef;
    if (voice) {
      const a = film.assets[voice];
      if (!a) add(field("intent", "narration", "voiceRef"), `unknown asset "${voice}"`);
      else if (a.kind !== "audio") add(field("intent", "narration", "voiceRef"), `asset "${voice}" is not audio`);
    }
    s.intent?.references?.forEach((r, j) => {
      if (!film.assets[r]) add(field("intent", "references", j), `unknown asset "${r}"`);
    });
    if (i === 0 && s.transition) add(field("transition"), "the first scene in sequence has no incoming transition");
  });

  // --- timeline ---
  const tl = film.timeline;
  const sceneIds = new Set(film.scenes.map((s) => s.id));
  const seen = new Set<string>();
  tl.sequence.forEach((id, i) => {
    if (!sceneIds.has(id)) add(["timeline", "sequence", i], `unknown scene "${id}"`);
    else if (seen.has(id)) add(["timeline", "sequence", i], `scene "${id}" appears twice`);
    seen.add(id);
  });
  for (const id of sceneIds) if (!seen.has(id)) add(["timeline", "sequence"], `scene "${id}" is missing from sequence`);

  const trackIds = new Set<string>();
  let subtitleTracks = 0;
  tl.tracks.forEach((t, i) => {
    const field = (...rest: PathSegment[]) => ["timeline", "tracks", i, ...rest];
    if (trackIds.has(t.id)) add(field("id"), `track id "${t.id}" is already used`);
    trackIds.add(t.id);
    if (t.kind === "subtitles") {
      subtitleTracks++;
      if (t.source !== "scenes") {
        // A whole-film subtitle file: it must be an asset, so existence, planning
        // and staleness all work the same way as any other input.
        const asset = film.assets[t.source];
        if (!asset) add(field("source"), `unknown asset "${t.source}"`, 'use "scenes" or the name of an asset with kind: subtitle');
        else if (asset.kind !== "subtitle") add(field("source"), `asset "${t.source}" is ${asset.kind}, the subtitle track needs kind: subtitle`);
        else if (!isGeneratedAsset(asset) && !asset.uri.endsWith(".srt")) add(field("source"), `asset "${t.source}" is not an .srt file`);
      }
      return;
    }
    if (t.kind === "audio" && t.stems !== undefined) {
      add(field("stems"), "stems is reserved and not implemented in v1alpha1");
    }
    const asset = film.assets[t.asset];
    const wantKind = t.kind === "audio" ? "audio" : "image";
    if (!asset) add(field("asset"), `unknown asset "${t.asset}"`);
    else {
      if (asset.kind !== wantKind) add(field("asset"), `asset "${t.asset}" is ${asset.kind}, track needs ${wantKind}`);
      if (!isGeneratedAsset(asset) && isUrl(asset.uri)) add(field("asset"), "URL assets cannot be used by tracks; build does not download");
      // fit: exact is a contract about the music's segment boundaries (spec §1.8.2).
      if (t.kind === "audio" && t.fit === "exact" && !t.cues) {
        add(field("fit"), `fit "exact" requires cues: a filmkit/cues-v1 file with the piece's segment boundaries`, "write it from the tool's own timing data, or use fit: loop");
      }
      if (t.kind === "audio" && t.fit !== "exact" && t.cues) {
        add(field("cues"), `cues is only read when fit is "exact"`);
      }
      if (t.kind === "audio" && t.cues && !insideProject(dir, t.cues)) {
        add(field("cues"), "path escapes the project directory");
      }
    }
    if (typeof t.to === "number" && t.to <= t.from) add(field("to"), "to must be greater than from");
  });
  if (subtitleTracks > 1) add(["timeline", "tracks"], "at most one subtitles track is allowed");
}

function checkImpl(loaded: LoadedFilm, node: Node, errors: ErrorCollector): void {
  const { src, profiles } = loaded;
  const add = (path: PathSegment[], message: string, hint?: string) =>
    errors.add(at(invalid(message, { field: formatFieldPath(path), hint }), src));
  const prof = profiles.get(node.impl.profile);
  if (!prof) {
    add([...node.field, "impl", "profile"], `profile "${node.impl.profile}" is not registered in profiles`, `registered: ${[...profiles.keys()].join(", ") || "(none)"}`);
    return;
  }
  const task = prof.profile.tasks[node.impl.task];
  if (!task) {
    add([...node.field, "impl", "task"], `profile "${node.impl.profile}" has no task "${node.impl.task}"`, `tasks: ${Object.keys(prof.profile.tasks).join(", ")}`);
    return;
  }
  for (const e of validateParams(prof.paramsValidators[node.impl.task]!, node.impl.params, src, [...node.field, "impl", "params"])) {
    errors.add(e);
  }
  for (const required of task.produces ?? []) {
    if (!node.produces[required]) add([...node.field, "produces"], `task "${node.impl.task}" requires produces.${required}`);
  }
}

function kindToProduce(kind: Asset["kind"]): ProduceType | undefined {
  switch (kind) {
    case "image": case "video": case "audio": case "subtitle": case "file": return kind;
    default: return undefined;
  }
}

/** Attach YAML position to an error whose `field` is a path in `src`. */
export function at(e: ErrorDetail, src: YamlSource): ErrorDetail {
  if (e.line !== undefined || !e.field) return e;
  const pos = positionOf(src, fieldToSegments(e.field));
  return { ...e, line: pos?.line, column: pos?.column };
}

export function fieldToSegments(field: string): PathSegment[] {
  const segs: PathSegment[] = [];
  for (const part of field.split(".")) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) { segs.push(part); continue; }
    if (m[1]) segs.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) segs.push(Number(idx[1]));
  }
  return segs;
}

