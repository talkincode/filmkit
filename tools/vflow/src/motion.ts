// A narrow reader for vflow's versioned dynamic reference material. It does not
// approve anything or prepare provider inputs: those decisions remain in vflow.
// Only exact material pins with an approved revision are consumed; reference
// videos and white-model frames must never masquerade as final/identity assets.
import { fail, invalid } from "./errors.ts";

export interface MotionReference {
  id: string;
  revision: number;
  shotId: string;
  compositionRevision: number;
  fps: number;
  durationFrames: number;
  scene: { id: string; revision: number };
  environmentVariant: string;
  subjects: unknown[];
  usage: string[];
  provenance: string;
  video: string;
  overview: string;
  source: string;
  keyframes: { id: string; asset: string; momentFrame: number; purpose: string; note?: string }[];
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const canonical = (v: unknown): string => JSON.stringify(sort(v));
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (object(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)]));
  return v;
}

/** Read only the approved motion materials actually pinned by this composition. */
export function readMotionReferences(deps: Obj, comp: Obj, bundleRevision: unknown): { motions: MotionReference[]; warnings: string[] } {
  const motions: MotionReference[] = [];
  const warnings: string[] = [];
  const authoring = object(comp.authoring) ? comp.authoring : {};
  const pins = list(authoring.materials).filter(object);
  const materialVersions = list(deps.materials).filter(object);
  const baselines = list(deps.compositionBaselines).filter(object);
  for (const pin of pins) {
    const version = materialVersions.find((r) => object(r.document) && r.document.id === pin.id && r.revision === pin.revision);
    if (!version || !object(version.document) || version.document.kind !== "motion_reference") continue;
    const doc = version.document;
    const field = `dependencies.materials.${String(pin.id)}@${String(pin.revision)}`;
    const bad = (name: string, message: string): never => fail(invalid(message, { field: `${field}.${name}` }));
    if (version.status !== "approved") {
      warnings.push(`motion reference ${String(pin.id)}@${String(pin.revision)} is not approved; not imported`);
      continue;
    }
    if (!positive(version.revision) || typeof doc.id !== "string") bad("revision", "motion reference needs a fixed revision and id");
    if (!["vflow/reference-workflow/v1", "video-compose/reference-workflow/v1"].includes(String(doc.schemaVersion))) bad("schemaVersion", "unsupported motion reference schema version");
    if (version.projectId !== comp.project) bad("projectId", "motion reference belongs to another project");
    if (doc.compositionId !== comp.id || typeof doc.shotId !== "string" || !object(comp.shots) || !object(comp.shots[doc.shotId])) bad("shotId", "motion reference targets another composition or an unknown shot");
    if (!positive(doc.compositionRevision) || !positive(doc.fps) || !positive(doc.durationFrames)) bad("durationFrames", "motion reference needs a fixed composition revision, positive fps and frame count");
    const shot = (comp.shots as Obj)[doc.shotId as string] as Obj;
    // Reference video may use another fps (e.g. 96 frames @24 fps for a
    // 120-frame @30 fps shot). Compare time, not raw frame counts.
    if (!object(comp.format) || typeof shot.durationFrames !== "number" || typeof comp.format.fps !== "number" || Math.abs((doc.durationFrames as number) / (doc.fps as number) - shot.durationFrames / comp.format.fps) > 1e-9) bad("durationFrames", "motion reference timing has drifted from the target shot");
    // set_authoring creates a later composition revision. The exported baseline
    // lets a reader prove that this material still describes precisely this shot.
    const baseline = baselines.find((b) => b.id === comp.id && b.revision === doc.compositionRevision);
    if (baseline && object(baseline.document) && object(baseline.document.shots)) {
      // Candidate/selected outputs are results, not changes to this design.
      const design = (s: unknown) => object(s) ? { description: s.description, prompts: s.prompts, durationFrames: s.durationFrames, dependsOn: list(s.dependsOn).map(canonical).sort() } : undefined;
      if (canonical(design(baseline.document.shots[doc.shotId as string])) !== canonical(design(shot)) || canonical(baseline.document.format) !== canonical(comp.format)) bad("compositionRevision", "motion reference shot or format has drifted from its pinned baseline");
    } else if (bundleRevision !== doc.compositionRevision) {
      bad("compositionRevision", "motion reference baseline is missing from the portable bundle");
    }
    if (!object(doc.scene) || typeof doc.scene.id !== "string" || !positive(doc.scene.revision) || typeof doc.environmentVariant !== "string") bad("scene", "motion reference needs a fixed scene and environment variant");
    const scenePin = pins.find((p) => p.id === (doc.scene as Obj).id);
    if (scenePin && scenePin.revision !== (doc.scene as Obj).revision) bad("scene", "motion reference scene revision differs from the composition's pinned scene");
    if (!object(doc.review) || doc.review.decision !== "accepted") bad("review", "approved motion reference is missing accepted review evidence");
    const review = doc.review as Obj;
    if (!["human", "external"].includes(String(review.method)) || typeof review.evidence !== "string" || !review.evidence.trim() || typeof review.reviewer !== "string" || !review.reviewer.trim()) bad("review", "approved motion reference needs attributable review evidence");
    const checks = object(review.checks) ? review.checks : {};
    for (const check of ["whitebox_only", "scene_geometry_match", "subject_blocking_match", "timing_verified", "keyframes_match_video", "text_policy"]) {
      if (checks[check] !== "pass") bad(`review.checks.${check}`, `approved motion reference is missing a passed ${check} check`);
    }
    const bindings = list(shot.subjects).filter(object);
    const owners = list(doc.subjects).filter(object);
    const key = (id: unknown, revision: unknown, variant: unknown) => `${String(id)}@${String(revision)}/${String(variant)}`;
    const expected = bindings.map((b) => {
      const snapshot = list(deps.subjects).filter(object).find((s) => s.id === b.subjectId && s.revision === b.subjectRevision);
      return key(b.subjectId, b.subjectRevision, b.variant ?? snapshot?.defaultVariant);
    }).sort();
    const actual = owners.map((s) => key(s.id, s.revision, s.variant)).sort();
    if (canonical(expected) !== canonical(actual)) bad("subjects", "motion reference subject revisions or variants differ from the target shot");
    const asset = (value: unknown, name: string): string => {
      if (!object(value) || typeof value.asset !== "string") bad(name, `motion reference ${name} needs an asset id`);
      return (value as Obj).asset as string;
    };
    const allowed = ["camera_motion", "blocking", "action_timing", "framing"];
    const usage = list(doc.usage);
    if (!usage.length || new Set(usage).size !== usage.length || !usage.every((u) => allowed.includes(String(u))) || typeof doc.provenance !== "string" || !doc.provenance.trim()) bad("usage", "motion reference needs explicit motion-only usage and provenance");
    const frames = list(doc.keyframes).map((v, i) => {
      if (!object(v) || typeof v.id !== "string" || typeof v.asset !== "string" || typeof v.momentFrame !== "number" || !Number.isInteger(v.momentFrame) || v.momentFrame < 0 || v.momentFrame >= (doc.durationFrames as number)) bad(`keyframes[${i}]`, "invalid motion keyframe");
      const f = v as Obj;
      if (!allowed.includes(String(f.purpose))) bad(`keyframes[${i}].purpose`, "white-model keyframes cannot be identity, first-frame or last-frame inputs");
      if (!usage.includes(f.purpose)) bad(`keyframes[${i}].purpose`, "keyframe purpose is not declared in motion usage");
      return { id: f.id as string, asset: f.asset as string, momentFrame: f.momentFrame as number, purpose: f.purpose as string, ...(typeof f.note === "string" ? { note: f.note } : {}) };
    });
    const roleAssets = [asset(doc.video, "video"), asset(doc.overview, "overview"), asset(doc.source, "source"), ...frames.map((f) => f.asset)];
    if (!frames.length || new Set(roleAssets).size !== roleAssets.length || new Set(frames.map((f) => f.id)).size !== frames.length || new Set(frames.map((f) => f.momentFrame)).size !== frames.length) bad("keyframes", "motion roles, keyframe ids and moments must be distinct and non-empty");
    motions.push({
      id: doc.id as string, revision: version.revision as number, shotId: doc.shotId as string,
      compositionRevision: doc.compositionRevision as number, fps: doc.fps as number, durationFrames: doc.durationFrames as number,
      scene: doc.scene as MotionReference["scene"], environmentVariant: doc.environmentVariant as string,
      subjects: list(doc.subjects), usage: usage as string[], provenance: doc.provenance as string, video: asset(doc.video, "video"), overview: asset(doc.overview, "overview"), source: asset(doc.source, "source"), keyframes: frames,
    });
  }
  return { motions, warnings };
}
