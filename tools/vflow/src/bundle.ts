// Reads a vflow portable composition bundle (`composition_export`, REST
// `.../export`) and keeps only what filmkit needs: shot descriptions, shot
// material images, pinned subjects with their reference packs, and the asset
// manifest those point at. Everything else in the document is ignored on
// purpose — this is a consumer, not a validator of vflow's protocol.
//
// Strict about the fields it reads (wrong shape => invalid-input with a field
// path), tolerant of everything else (unknown fields, v2 authoring material).

import YAML from "yaml";
import { type Detail, fail, invalid } from "./errors.ts";
import { readMotionReferences, type MotionReference } from "./motion.ts";

/** apiVersions this reader understands. `video-compose/*` is vflow's pre-rename wire id. */
const API_VERSIONS: Record<string, "v1" | "v2"> = {
  "vflow/v1": "v1",
  "video-compose/v1": "v1",
  "vflow/v2": "v2",
  "video-compose/v2": "v2",
};

export interface AssetRef {
  asset: string;
  role?: string;
  notes?: string;
}

export interface Shot {
  description: string;
  durationFrames?: number;
  prompts: { image?: string; video?: string; audio?: string };
  /** `references.images` — the shot's reference material. */
  references: AssetRef[];
  /** `candidates.images` — material candidates attached to the shot. */
  candidateImages: AssetRef[];
  /** Reference videos are inputs only; they are never selected outputs. */
  referenceVideos: AssetRef[];
  subjects: { subjectId: string; subjectRevision: number; variant?: string }[];
  selectedVideo: string | null;
  /** Counts of things this reader does not import (reported, never silently dropped). */
  skipped: { dependsOn: number; candidateVideos: number; candidateAudios: number; selectedAudio: number };
}

export interface PackEntry {
  asset: string;
  view?: string;
  purpose?: string;
  status: "candidate" | "approved";
  notes?: string;
}

export interface Subject {
  id: string;
  kind: string;
  revision: number;
  name: string;
  defaultVariant?: string;
  description: string;
  invariants: string[];
  variants: Record<string, { description: string; referencePack: PackEntry[] }>;
}

export interface AssetEntry {
  id: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Bundle {
  /** Canonical wire id as found in the document (not rewritten). */
  apiVersion: string;
  generation: "v1" | "v2";
  revision?: number;
  composition: {
    id: string;
    project: string;
    title?: string;
    format: { width: number; height: number; fps: number };
    sequence: string[];
    shots: Record<string, Shot>;
    audioTracks: number;
    /** v2 only: pinned authoring materials (not imported). */
    materials: number;
  };
  /** Keyed `<id>@<revision>`. */
  subjects: Map<string, Subject>;
  assets: Map<string, AssetEntry>;
  motions: MotionReference[];
  motionWarnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export const subjectKey = (id: string, revision: number): string => `${id}@${revision}`;

/** Parse bundle text (JSON or YAML) or an already parsed value. Accepts the bare bundle or the `{ bundle, serialized }` wrapper REST/MCP return. */
export function parseBundle(input: string | unknown, source = "bundle"): Bundle {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = YAML.parse(input);
    } catch (err) {
      fail(invalid(`${source}: not valid JSON/YAML: ${(err as Error).message}`));
    }
  }
  if (isObj(raw) && isObj(raw.bundle) && raw.composition === undefined) raw = raw.bundle;
  if (!isObj(raw)) fail(invalid(`${source}: expected a vflow bundle object`));

  const errors: Detail[] = [];
  const bad = (field: string, message: string, hint?: string): void => {
    errors.push(invalid(message, { field, ...(hint ? { hint } : {}) }));
  };

  const apiVersion = raw.apiVersion;
  const generation = typeof apiVersion === "string" ? API_VERSIONS[apiVersion] : undefined;
  if (!generation) {
    fail(
      invalid(`unsupported apiVersion ${JSON.stringify(apiVersion)}`, {
        field: "apiVersion",
        hint: `this reader understands ${Object.keys(API_VERSIONS).join(", ")}; export the composition from vflow again`,
      }),
    );
  }

  const comp = raw.composition;
  if (!isObj(comp)) fail(invalid("missing composition", { field: "composition" }));

  const format = isObj(comp.format) ? comp.format : {};
  if (!isPosInt(format.width)) bad("composition.format.width", "must be a positive integer");
  if (!isPosInt(format.height)) bad("composition.format.height", "must be a positive integer");
  if (!isPosInt(format.fps)) bad("composition.format.fps", "must be a positive integer");
  if (!isStr(comp.id)) bad("composition.id", "must be a non-empty string");
  if (!isStr(comp.project)) bad("composition.project", "must be a non-empty string");
  if (!Array.isArray(comp.sequence) || !comp.sequence.every(isStr)) bad("composition.sequence", "must be an array of shot ids");
  if (!isObj(comp.shots)) bad("composition.shots", "must be an object keyed by shot id");

  const deps = isObj(raw.dependencies) ? raw.dependencies : {};

  // ---- assets manifest ----
  const assets = new Map<string, AssetEntry>();
  const rawAssets = Array.isArray(deps.assets) ? deps.assets : [];
  rawAssets.forEach((a, i) => {
    const f = `dependencies.assets[${i}]`;
    if (!isObj(a) || !isStr(a.id)) return bad(`${f}.id`, "must be a non-empty string");
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) return bad(`${f}.sha256`, "must be a 64-char lowercase hex digest");
    if (!isStr(a.mimeType)) return bad(`${f}.mimeType`, "must be a non-empty string");
    if (!isNonNegInt(a.sizeBytes)) return bad(`${f}.sizeBytes`, "must be a non-negative integer");
    assets.set(a.id, { id: a.id, sha256: a.sha256, mimeType: a.mimeType, sizeBytes: a.sizeBytes });
  });

  // ---- subjects ----
  const subjects = new Map<string, Subject>();
  const rawSubjects = Array.isArray(deps.subjects) ? deps.subjects : [];
  rawSubjects.forEach((s, i) => {
    const f = `dependencies.subjects[${i}]`;
    if (!isObj(s) || !isStr(s.id) || !isPosInt(s.revision)) return bad(f, "needs a string id and a positive integer revision");
    const def = isObj(s.definition) ? s.definition : {};
    const variants: Subject["variants"] = {};
    for (const [vName, v] of Object.entries(isObj(s.variants) ? s.variants : {})) {
      const vf = `${f}.variants.${vName}`;
      const pack: PackEntry[] = [];
      const rawPack = isObj(v) && Array.isArray(v.referencePack) ? v.referencePack : [];
      rawPack.forEach((e, j) => {
        if (!isObj(e) || !isStr(e.asset)) return bad(`${vf}.referencePack[${j}].asset`, "must be an asset id");
        if (e.status !== "candidate" && e.status !== "approved") return bad(`${vf}.referencePack[${j}].status`, "must be candidate or approved");
        pack.push({
          asset: e.asset,
          status: e.status,
          ...(isStr(e.view) ? { view: e.view } : {}),
          ...(isStr(e.purpose) ? { purpose: e.purpose } : {}),
          ...(isStr(e.notes) ? { notes: e.notes } : {}),
        });
      });
      variants[vName] = { description: isObj(v) && typeof v.description === "string" ? v.description : "", referencePack: pack };
    }
    subjects.set(subjectKey(s.id, s.revision), {
      id: s.id,
      kind: typeof s.kind === "string" ? s.kind : "subject",
      revision: s.revision,
      name: typeof s.name === "string" && s.name !== "" ? s.name : s.id,
      ...(isStr(s.defaultVariant) ? { defaultVariant: s.defaultVariant } : {}),
      description: typeof def.description === "string" ? def.description : "",
      invariants: Array.isArray(def.invariants) ? def.invariants.filter(isStr) : [],
      variants,
    });
  });

  // ---- shots ----
  const shots: Record<string, Shot> = {};
  const refList = (v: unknown, field: string): AssetRef[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      bad(field, "must be an array");
      return [];
    }
    const out: AssetRef[] = [];
    v.forEach((e, i) => {
      if (!isObj(e) || !isStr(e.asset)) return bad(`${field}[${i}].asset`, "must be an asset id");
      out.push({ asset: e.asset, ...(isStr(e.role) ? { role: e.role } : {}), ...(isStr(e.notes) ? { notes: e.notes } : {}) });
    });
    return out;
  };
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  if (isObj(comp.shots)) {
    for (const [shotId, s] of Object.entries(comp.shots)) {
      const f = `composition.shots.${shotId}`;
      if (!isObj(s)) {
        bad(f, "must be an object");
        continue;
      }
      if (s.durationFrames !== undefined && !isNonNegInt(s.durationFrames)) bad(`${f}.durationFrames`, "must be a non-negative integer");
      const refs = isObj(s.references) ? s.references : {};
      const cands = isObj(s.candidates) ? s.candidates : {};
      const sel = isObj(s.selected) ? s.selected : {};
      const prompts = isObj(s.prompts) ? s.prompts : {};
      const bindings: Shot["subjects"] = [];
      (Array.isArray(s.subjects) ? s.subjects : []).forEach((b, i) => {
        if (!isObj(b) || !isStr(b.subjectId) || !isPosInt(b.subjectRevision)) return bad(`${f}.subjects[${i}]`, "needs subjectId and a positive integer subjectRevision");
        bindings.push({ subjectId: b.subjectId, subjectRevision: b.subjectRevision, ...(isStr(b.variant) ? { variant: b.variant } : {}) });
      });
      shots[shotId] = {
        description: typeof s.description === "string" ? s.description : "",
        ...(isNonNegInt(s.durationFrames) ? { durationFrames: s.durationFrames } : {}),
        prompts: {
          ...(isStr(prompts.image) ? { image: prompts.image } : {}),
          ...(isStr(prompts.video) ? { video: prompts.video } : {}),
          ...(isStr(prompts.audio) ? { audio: prompts.audio } : {}),
        },
        references: refList(refs.images, `${f}.references.images`),
        candidateImages: refList(cands.images, `${f}.candidates.images`),
        referenceVideos: refList(refs.videos, `${f}.references.videos`),
        subjects: bindings,
        selectedVideo: isStr(sel.video) ? sel.video : null,
        skipped: {
          dependsOn: count(s.dependsOn),
          candidateVideos: count(cands.videos),
          candidateAudios: count(cands.audios),
          selectedAudio: isStr(sel.audio) ? 1 : 0,
        },
      };
    }
    const known = comp.shots;
    if (Array.isArray(comp.sequence)) {
      comp.sequence.forEach((id, i) => {
        if (isStr(id) && !(id in known)) bad(`composition.sequence[${i}]`, `unknown shot "${id}"`);
      });
    }
  }

  if (errors.length) fail(...errors);

  const authoring = comp.authoring;
  const materials = isObj(authoring) && Array.isArray(authoring.materials) ? authoring.materials.length : 0;

  const motion = readMotionReferences(deps, comp, raw.revision);
  return {
    motions: motion.motions,
    motionWarnings: motion.warnings,
    apiVersion: apiVersion as string,
    generation: generation!,
    ...(isNonNegInt(raw.revision) ? { revision: raw.revision } : {}),
    composition: {
      id: comp.id as string,
      project: comp.project as string,
      ...(isStr(comp.title) ? { title: comp.title } : {}),
      format: { width: format.width as number, height: format.height as number, fps: format.fps as number },
      sequence: comp.sequence as string[],
      shots,
      audioTracks: Array.isArray(comp.audioTracks) ? comp.audioTracks.length : 0,
      materials,
    },
    subjects,
    assets,
  };
}
