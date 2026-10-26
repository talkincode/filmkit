// Loading and validating a blockout scene declaration.
//
//   text -> parseLocated (syntax errors with line/column)
//        -> JSON Schema (structure; unknown fields rejected; errors carry field + line)
//        -> semantic checks (references, ranges, uniqueness, camera sanity)
//        -> compileScene (the shared evaluator's input)
//
// Everything that can be wrong with a declaration is reported here, before any
// engine, ffmpeg or Blender runs.

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import schema from "../schema/scene.schema.json" with { type: "json" };
import {
  ATTACH_POINTS,
  compileScene,
  evaluate,
  timeAtFrame,
  type BlockoutScene,
  type CompiledScene,
} from "../runtime/blockout-core.js";
import { BlockoutError, fail, invalid, io, type Detail } from "./errors.ts";
import { parseLocated, pathToField, type JsonSource } from "./json-source.ts";

export interface LoadedScene {
  /** The declaration exactly as written. */
  scene: BlockoutScene;
  compiled: CompiledScene;
  /** sha256 of the file's raw bytes: the pin the manifest records. */
  sha256: string;
  /** The raw bytes, so a source archive carries the declaration verbatim. */
  bytes: Uint8Array;
  path: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, discriminator: true });
const validateSchema = ajv.compile(schema);

export function sceneSchema(): unknown {
  return schema;
}

export function loadScene(path: string): LoadedScene {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    return fail(io(`cannot read ${path}: ${(err as Error).message}`));
  }
  return parseScene(new TextDecoder().decode(bytes), bytes, path);
}

export function parseScene(text: string, bytes: Uint8Array, path: string): LoadedScene {
  const source = parseLocated(text, path);
  const structural = schemaErrors(source);
  const details = structural.length ? structural : semanticErrors(source);
  if (details.length) throw new BlockoutError(details);
  const scene = source.value as BlockoutScene;
  return { scene, compiled: compileScene(scene), sha256: createHash("sha256").update(bytes).digest("hex"), bytes, path };
}

// ───────────────────────── structure ─────────────────────────

function segmentsOf(instancePath: string): (string | number)[] {
  return instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function at(source: JsonSource, segments: (string | number)[]): Pick<Detail, "field" | "line" | "column"> {
  // the deepest recorded ancestor is the best place to point at
  for (let n = segments.length; n >= 0; n--) {
    const p = source.positions.get(pathToField(segments.slice(0, n)));
    if (p) return { field: pathToField(segments), line: p.line, column: p.column };
  }
  return { field: pathToField(segments) };
}

function describe(e: ErrorObject): { message: string; extra: (string | number)[] } {
  switch (e.keyword) {
    case "additionalProperties":
      return { message: `unknown field "${e.params.additionalProperty}"`, extra: [String(e.params.additionalProperty)] };
    case "required":
      return { message: `missing required field "${e.params.missingProperty}"`, extra: [] };
    case "enum":
      return { message: `must be one of ${(e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`, extra: [] };
    case "const":
      return { message: `must be ${JSON.stringify(e.params.allowedValue)}`, extra: [] };
    case "discriminator":
      return { message: e.message ?? "invalid shape", extra: [] };
    default:
      return { message: e.message ?? "invalid", extra: [] };
  }
}

function schemaErrors(source: JsonSource): Detail[] {
  if (validateSchema(source.value)) return [];
  const seen = new Set<string>();
  const out: Detail[] = [];
  for (const e of validateSchema.errors ?? []) {
    if (e.keyword === "oneOf" || e.keyword === "if") continue; // discriminator already named the real cause
    const { message, extra } = describe(e);
    const segments = [...segmentsOf(e.instancePath), ...extra];
    const d = invalid(message, at(source, e.keyword === "required" ? segmentsOf(e.instancePath) : segments));
    if (e.keyword === "required") d.field = pathToField([...segmentsOf(e.instancePath), String(e.params.missingProperty)]);
    const key = `${d.field}|${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

// ───────────────────────── semantics ─────────────────────────

function semanticErrors(source: JsonSource): Detail[] {
  const s = source.value as BlockoutScene;
  const out: Detail[] = [];
  const bad = (message: string, segments: (string | number)[], hint?: string) => out.push(invalid(message, { ...at(source, segments), ...(hint ? { hint } : {}) }));
  const last = s.timing.durationFrames - 1;

  // shot and scene may both be given; a blockout stands in for at least one of them
  if (!s.binding.shot && !s.binding.scene) {
    bad("binding needs at least one of shot or scene", ["binding"], "a blockout stands in for a shot, a scene, or both (give both when handing it off upstream)");
  }
  const env = s.binding.environment;
  if (env) {
    if (!!env.id !== !!env.revision) bad("environment id and revision go together", ["binding", "environment", env.id ? "revision" : "id"]);
    if (!env.id && !env.variant) bad("an environment binding needs id + revision and/or a variant", ["binding", "environment"]);
  }

  // ids are one namespace: attach and manifest bindings refer to them
  const ids = new Map<string, string>();
  const claim = (id: string, segments: (string | number)[]) => {
    const prev = ids.get(id);
    if (prev) bad(`duplicate id "${id}" (also used at ${prev})`, [...segments, "id"]);
    else ids.set(id, pathToField(segments));
  };
  (s.environment?.walls ?? []).forEach((w, i) => claim(w.id, ["environment", "walls", i]));
  (s.environment?.blocks ?? []).forEach((b, i) => claim(b.id, ["environment", "blocks", i]));
  (s.subjects ?? []).forEach((x, i) => claim(x.id, ["subjects", i]));
  (s.props ?? []).forEach((x, i) => claim(x.id, ["props", i]));

  const keyframeRules = (list: { frame: number }[], base: (string | number)[]) => {
    const frames = new Set<number>();
    list.forEach((k, i) => {
      if (k.frame > last) bad(`frame ${k.frame} is past the last frame (${last}; durationFrames is ${s.timing.durationFrames})`, [...base, i, "frame"]);
      if (frames.has(k.frame)) bad(`two keyframes on frame ${k.frame}: merge them`, [...base, i, "frame"]);
      frames.add(k.frame);
    });
  };
  const needsChannel = (list: Record<string, unknown>[], channel: string, base: (string | number)[], owner: string) => {
    if (!list.some((k) => k[channel] !== undefined)) bad(`${owner} never sets "${channel}" in any keyframe`, base, `give at least one keyframe a ${channel}`);
  };

  (s.environment?.walls ?? []).forEach((w, i) => {
    if (w.from[0] === w.to[0] && w.from[1] === w.to[1]) bad("a wall needs two different end points", ["environment", "walls", i, "to"]);
  });
  const shapeRules = (shape: { type: string; radius?: number; height?: number }, base: (string | number)[]) => {
    if (shape.type === "capsule" && shape.radius! * 2 > shape.height!) bad("a capsule's height includes both caps: height must be at least 2 * radius", [...base, "height"]);
  };
  (s.environment?.blocks ?? []).forEach((b, i) => shapeRules(b.shape, ["environment", "blocks", i, "shape"]));

  (s.subjects ?? []).forEach((sub, i) => {
    keyframeRules(sub.keyframes, ["subjects", i, "keyframes"]);
    needsChannel(sub.keyframes as never, "pos", ["subjects", i, "keyframes"], `subject "${sub.id}"`);
    if (sub.kind === "capsule") {
      sub.keyframes.forEach((k, j) => {
        if (k.joints) bad(`subject "${sub.id}" is a capsule: it has no joints (use kind "humanoid")`, ["subjects", i, "keyframes", j, "joints"]);
      });
      if (sub.radius !== undefined && sub.radius * 2 > sub.height) bad("radius * 2 must not exceed height", ["subjects", i, "radius"]);
    } else if (sub.radius !== undefined) {
      bad('"radius" only applies to kind "capsule"', ["subjects", i, "radius"]);
    }
  });

  (s.props ?? []).forEach((p, i) => {
    keyframeRules(p.keyframes ?? [], ["props", i, "keyframes"]);
    needsChannel((p.keyframes ?? []) as never, "pos", ["props", i, "keyframes"], `prop "${p.id}"`);
    shapeRules(p.shape, ["props", i, "shape"]);
    const windows: { from: number; to: number }[] = [];
    (p.attach ?? []).forEach((a, j) => {
      const host = (s.subjects ?? []).find((x) => x.id === a.subject);
      if (!host) bad(`attach refers to unknown subject "${a.subject}"`, ["props", i, "attach", j, "subject"], `subjects: ${(s.subjects ?? []).map((x) => x.id).join(", ") || "(none)"}`);
      else if (host.kind !== "humanoid") bad(`subject "${a.subject}" is a capsule: only a humanoid has joints to hold a prop`, ["props", i, "attach", j, "subject"]);
      if (!ATTACH_POINTS.includes(a.joint)) bad(`unknown joint "${a.joint}"`, ["props", i, "attach", j, "joint"]);
      if (a.from > a.to) bad(`attach window from ${a.from} to ${a.to} is empty`, ["props", i, "attach", j, "to"]);
      if (a.to > last) bad(`attach window ends past the last frame (${last})`, ["props", i, "attach", j, "to"]);
      for (const w of windows) if (a.from <= w.to && a.to >= w.from) bad(`attach windows of prop "${p.id}" overlap`, ["props", i, "attach", j, "from"]);
      windows.push(a);
    });
  });

  keyframeRules(s.camera.keyframes, ["camera", "keyframes"]);
  for (const channel of ["pos", "target", "focalLength"]) needsChannel(s.camera.keyframes as never, channel, ["camera", "keyframes"], "the camera");

  if (s.overview) {
    if (s.overview.frame !== undefined && s.overview.frame > last) bad(`overview.frame is past the last frame (${last})`, ["overview", "frame"]);
    if (!!s.overview.pos !== !!s.overview.target && (s.overview.pos || s.overview.target)) bad("overview needs both pos and target, or neither (auto framing)", ["overview", s.overview.pos ? "target" : "pos"]);
  }
  if (s.stills) {
    const seen = new Set<number>();
    s.stills.forEach((f, i) => {
      if (f > last) bad(`still frame ${f} is past the last frame (${last})`, ["stills", i]);
      if (seen.has(f)) bad(`still frame ${f} is listed twice`, ["stills", i]);
      seen.add(f);
    });
  }
  if (out.length) return out;

  // the camera must be well-defined on every frame, not only on the keyframes
  const compiled = compileScene(s);
  for (let f = 0; f < s.timing.durationFrames; f++) {
    try {
      evaluate(compiled, timeAtFrame(compiled, f));
    } catch (err) {
      bad((err as Error).message, ["camera", "keyframes"], "move the camera or its target so it never looks straight up or down");
      break;
    }
  }
  return out;
}

/**
 * What a hand-off to an upstream system needs on top of what rendering needs: the shot AND the scene,
 * the environment variant, and a variant for every subject and prop. Returns declaration field paths.
 * Rendering never needs these; `--handoff` makes their absence an error.
 */
export function handoffGaps(s: BlockoutScene): string[] {
  const gaps: string[] = [];
  if (!s.binding.shot) gaps.push("binding.shot");
  if (!s.binding.scene) gaps.push("binding.scene");
  if (!s.binding.environment?.variant) gaps.push("binding.environment.variant");
  (s.subjects ?? []).forEach((x, i) => {
    if (!x.binding.variant) gaps.push(`subjects[${i}].binding.variant`);
  });
  (s.props ?? []).forEach((x, i) => {
    if (!x.binding.variant) gaps.push(`props[${i}].binding.variant`);
  });
  return gaps;
}

/** Fails (invalid-input) with one error per missing binding field. */
export function requireHandoff(loaded: LoadedScene): void {
  const gaps = handoffGaps(loaded.scene);
  if (gaps.length) {
    fail(...gaps.map((field) => invalid(`handoff needs ${field}`, { field, hint: "--handoff asks for the complete binding an upstream system pins: composition, shot AND scene, environment variant, and a variant on every subject and prop" })));
  }
}

/** Frames exported as keyframe stills: declared, or every frame carrying a declared keyframe. */
export function stillFrames(s: BlockoutScene): number[] {
  if (s.stills) return [...s.stills].sort((a, b) => a - b);
  const frames = new Set<number>();
  for (const list of [s.camera.keyframes, ...(s.subjects ?? []).map((x) => x.keyframes), ...(s.props ?? []).map((x) => x.keyframes ?? [])]) {
    for (const k of list) frames.add(k.frame);
  }
  // the first and the last frame always bracket the clip
  frames.add(0);
  frames.add(s.timing.durationFrames - 1);
  const all = [...frames].filter((f) => f < s.timing.durationFrames).sort((a, b) => a - b);
  if (all.length > 32) fail(invalid(`the scene declares ${all.length} keyframe frames; list the frames you want in "stills" (at most 32 by default)`, { field: "stills" }));
  return all;
}
