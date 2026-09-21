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
  };
  return f;
}

function trackDefaults(raw: Track): Track {
  // `raw` comes straight from YAML, so every defaulted field may be absent.
  const t = raw as Partial<Track> & { id: string; kind: Track["kind"] };
  switch (t.kind) {
    case "audio": {
      const a = t as Partial<AudioTrack> & { id: string; asset: string };
      return {
        id: a.id,
        kind: "audio",
        asset: a.asset,
        fit: a.fit ?? "loop",
        volume: a.volume ?? 1,
        fadeIn: a.fadeIn ?? 0,
        fadeOut: a.fadeOut ?? 0,
        from: a.from ?? 0,
        to: a.to ?? "end",
        ...(a.cues !== undefined ? { cues: a.cues } : {}),
        ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
        ...(a.stems !== undefined ? { stems: a.stems } : {}),
      };
    }
    case "overlay": {
      const o = t as Partial<OverlayTrack> & { id: string; asset: string };
      return { id: o.id, kind: "overlay", asset: o.asset, position: o.position ?? "top-right", margin: o.margin ?? 32, opacity: o.opacity ?? 1, from: o.from ?? 0, to: o.to ?? "end", ...(o.width !== undefined ? { width: o.width } : {}) };
    }
    case "subtitles": {
      const s = t as Partial<SubtitlesTrack> & { id: string };
      return { id: s.id, kind: "subtitles", source: "scenes", mode: s.mode ?? "sidecar" };
    }
  }
}

export function nodesOf(film: Film): Node[] {
  const nodes: Node[] = [];
  Object.entries(film.assets).forEach(([id, a]) => {
    if (isGeneratedAsset(a)) nodes.push({ id, kind: "asset", impl: a.impl, produces: a.produces, inputs: a.inputs, field: ["assets", id] });
  });
  film.scenes.forEach((s, i) => {
    nodes.push({ id: s.id, kind: "scene", impl: s.impl, produces: s.produces, inputs: s.inputs, field: ["scenes", i] });
  });
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
    const hasMedia = Boolean(s.produces.video || s.produces.audio);
    if (s.duration === undefined && (s.durationPolicy !== "auto" || !hasMedia)) {
      add(field("duration"), `duration is required when durationPolicy is "${s.durationPolicy}" or the scene produces neither video nor audio`);
    }
    if (s.audioMode === "keep" && s.produces.audio) add(field("audioMode"), `audioMode "keep" contradicts produces.audio`);
    if (s.audioMode && !s.produces.video && !s.produces.audio) add(field("audioMode"), "audioMode has no effect without video or audio");
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
      if (t.mode === "burn") add(field("mode"), `subtitle mode "burn" is reserved and not implemented in v1alpha1`);
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

