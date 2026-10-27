// Template loading and workflow binding (PLAN D4/D5, §5.3).
//
// A template is an unmodified ComfyUI API JSON (h3-ref2va: dense and VSA variants;
// h3-fl2va: one dense workflow) plus bindings.json naming the exact node inputs
// we may patch. bindWorkflow() deep-copies the variant and writes only those
// fields; the only structural edits are the variant choice, the extra LoadImage
// nodes for ref2/ref3 and, when a h3-ref2va@2 job has an audio guide, the
// LoadAudio + MiniMaxH3AddGuide pair declared in bindings.audioGuide (spliced
// between the conditioning node and the guider, the wiring 李律 EP01 used with
// fl2va). h3-fl2va has that pair built in: its bindings name the LoadImage
// (first frame) and LoadAudio (driving audio) whose file names are bound.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT, invalid } from "./errors.ts";

export const TEMPLATES_ROOT = join(import.meta.dir, "..", "templates");

/**
 * Released templates; each `@N` is frozen (test/immutability.test.ts). Must equal the Profile's `template` enum.
 * @2 = @1 (same models, workflows and pins) + the `audioGuide` binding (MiniMaxH3AddGuide lip sync).
 */
export const TEMPLATE_NAMES = ["h3-ref2va@1", "h3-ref2va@2", "h3-fl2va@1"] as const;

export type WorkflowJson = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type Variant = "dense" | "vsa";

export interface Manifest {
  schema: string;
  template: string;
  comfyui: { repo: string; commit: string };
  customNodes: { repo: string; commit: string }[];
  weights: { repo: string; revision: string; file: string; subdir: string; bytes: number; sha256: string }[];
  launch: string[];
  diskFreeGB: number;
  verifySha256: boolean;
}

export interface Bindings {
  template: string;
  fps: number;
  /** h3-ref2va: dense + vsa; h3-fl2va: dense only (no VSA gate for fl2va). */
  variants: { dense: string; vsa?: string };
  bind: Record<"prompt" | "width" | "height" | "frames" | "seed" | "outputPrefix", [string, string]> & { sparsity?: [string, string] };
  /** Ref2VA reference images (`ref`..`ref3`). Absent for h3-fl2va. */
  refs?: { loadNode: string; target: string; inputPattern: string; indexBase: number; max: number };
  /** h3-fl2va: the LoadImage feeding the conditioning node's `first_frame` (params.image, required). */
  firstFrame?: { loadNode: string; target: [string, string] };
  /**
   * h3-fl2va: the built-in LoadAudio -> MiniMaxH3AddGuide (`guideNode`) of the workflow; params.audio is required
   * and bound into `loadNode`. (h3-ref2va@2 uses the optional `audioGuide` splice below instead.)
   */
  audio?: { loadNode: string; guideNode: string };
  /** Warm-time key in estimates.json for this template's jobs; default: the variant key (dense, vsa-0.75, ...). */
  estimateKey?: string;
  /**
   * Optional lip-sync guide: `loadNode` (LoadAudio) feeds `guideNode` (MiniMaxH3AddGuide), which takes the
   * conditioning `positive` and the AV `latent`, encodes the audio with `audioVae` and anchors it at `frameIdx`;
   * its output replaces `consumer` (the guider's conditioning input). Nodes are added only for jobs with audio,
   * so a job without audio binds to exactly the template workflow. Absent in h3-ref2va@1 (frozen); added in @2.
   */
  audioGuide?: {
    loadNode: string;
    guideNode: string;
    positive: [string, number];
    latent: [string, number];
    audioVae: [string, number];
    consumer: [string, string];
    frameIdx: number;
    requiredClasses: string[];
  };
  requiredClasses: string[];
}

export interface LengthSpec {
  min: number;
  max: number;
  step: number;
}

export interface Template {
  name: string;
  dir: string;
  manifest: Manifest;
  /** sha256 of the canonical manifest JSON (whitespace-insensitive). */
  manifestSha256: string;
  bindings: Bindings;
  bindingsSha256: string;
  objectInfo: { classes: Record<string, { inputs: Record<string, unknown> }> };
  variants: { dense: VariantFile; vsa?: VariantFile };
}

/** Size limits of the conditioning node (the one `bind.frames` points at): MiniMaxH3ReferenceToVideo / ImageToVideo. */
export interface VariantFile {
  file: string;
  fileSha256: string;
  workflow: WorkflowJson;
}

export interface ConditioningSpec {
  length: LengthSpec;
  width: { min: number; step: number };
  height: { min: number; step: number };
}

export function conditioningSpec(tpl: Template): ConditioningSpec {
  const [node] = tpl.bindings.bind.frames;
  const wf = tpl.variants.dense.workflow;
  const cls = wf[node]!.class_type;
  const spec = tpl.objectInfo.classes[cls]?.inputs as unknown as ConditioningSpec | undefined;
  if (!spec?.length || !spec.width || !spec.height) throw new Error(`template ${tpl.name}: object_info snapshot lacks ${cls} length/width/height`);
  return spec;
}

export interface ResolvedRef {
  /** The path as written in the film (film-relative). */
  path: string;
  sha256: string;
  ext: "png" | "jpg" | "webp";
}

export interface ResolvedAudio {
  /** The path as written in the film (film-relative). */
  path: string;
  sha256: string;
  ext: "wav";
  /** Duration from the WAV header (data bytes / byte rate). */
  durationSec: number;
}

/** Every input file of a job, content-hashed: what binding, cache keys, bundles and records all use. */
export interface ResolvedInputs {
  refs: ResolvedRef[];
  /** h3-fl2va first frame (params.image). */
  image?: ResolvedRef;
  audio?: ResolvedAudio;
}

const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]*@[0-9]+$/;

function readJson<T>(path: string): { value: T; raw: Buffer } {
  const raw = readFileSync(path);
  try {
    return { value: JSON.parse(raw.toString("utf8")) as T, raw };
  } catch (err) {
    throw new ColabComfyError(EXIT.io, [{ code: "io", message: `${path}: ${(err as Error).message}` }]);
  }
}

export function loadTemplate(name: string, root: string = TEMPLATES_ROOT): Template {
  // The name becomes a directory: reject anything that could leave `root`.
  if (!TEMPLATE_NAME.test(name)) {
    throw new ColabComfyError(EXIT.invalidInput, [invalid(`template "${name}" is not of the form <name>@<major>`, "template")]);
  }
  const dir = join(root, name);
  if (!existsSync(dir)) {
    throw new ColabComfyError(EXIT.invalidInput, [invalid(`unknown template "${name}" (no ${dir})`, "template")]);
  }
  const manifest = readJson<Manifest>(join(dir, "manifest.json"));
  const bindings = readJson<Bindings>(join(dir, "bindings.json"));
  const objectInfo = readJson<Template["objectInfo"]>(join(dir, "object_info.snapshot.json"));
  const variants = {} as Template["variants"];
  for (const v of ["dense", "vsa"] as const) {
    const file = bindings.value.variants[v];
    if (file === undefined) {
      if (v === "dense") throw new ColabComfyError(EXIT.io, [{ code: "io", message: `template ${name} has no dense variant` }]);
      continue;
    }
    const wf = readJson<WorkflowJson>(join(dir, file));
    variants[v] = { file, fileSha256: sha256Hex(wf.raw), workflow: wf.value };
  }
  const tpl: Template = {
    name,
    dir,
    manifest: manifest.value,
    manifestSha256: sha256Hex(canonicalJson(manifest.value)),
    bindings: bindings.value,
    bindingsSha256: sha256Hex(bindings.raw),
    objectInfo: objectInfo.value,
    variants,
  };
  checkBindingsResolve(tpl);
  return tpl;
}

/** Every bound path must exist in the variant it applies to; a drifted template fails here, loudly. */
function checkBindingsResolve(tpl: Template): void {
  const problems: string[] = [];
  if (tpl.variants.vsa && !tpl.bindings.bind.sparsity) problems.push("vsa variant without a sparsity binding");
  if (!tpl.bindings.refs === !tpl.bindings.firstFrame) problems.push("exactly one of refs / firstFrame must be bound");
  if (tpl.bindings.audio && tpl.bindings.audioGuide) problems.push("audio (built in) and audioGuide (optional splice) are exclusive");
  for (const v of ["dense", "vsa"] as const) {
    const variant = tpl.variants[v];
    if (!variant) continue;
    const wf = variant.workflow;
    for (const [key, [node, input]] of Object.entries(tpl.bindings.bind)) {
      if (key === "sparsity" && v === "dense") continue;
      if (!(input in (wf[node]?.inputs ?? {}))) problems.push(`${v}: binding ${key} -> ${node}.${input} does not exist`);
    }
    if (tpl.bindings.refs) {
      const { loadNode, target } = tpl.bindings.refs;
      if (wf[loadNode]?.class_type !== "LoadImage") problems.push(`${v}: node ${loadNode} is not a LoadImage`);
      if (!wf[target]) problems.push(`${v}: ref target node ${target} missing`);
    }
    if (tpl.bindings.firstFrame) {
      const { loadNode, target } = tpl.bindings.firstFrame;
      if (wf[loadNode]?.class_type !== "LoadImage") problems.push(`${v}: firstFrame node ${loadNode} is not a LoadImage`);
      const t = wf[target[0]]?.inputs[target[1]];
      if (!Array.isArray(t) || t[0] !== loadNode) problems.push(`${v}: ${target.join(".")} is not wired to firstFrame node ${loadNode}`);
    }
    if (tpl.bindings.audio) {
      const { loadNode, guideNode } = tpl.bindings.audio;
      if (wf[loadNode]?.class_type !== "LoadAudio") problems.push(`${v}: audio node ${loadNode} is not a LoadAudio`);
      const gi = wf[guideNode];
      if (gi?.class_type !== "MiniMaxH3AddGuide" || !Array.isArray(gi.inputs.audio) || gi.inputs.audio[0] !== loadNode) {
        problems.push(`${v}: audio guide node ${guideNode} is not a MiniMaxH3AddGuide fed by ${loadNode}`);
      }
    }
    const g = tpl.bindings.audioGuide;
    if (!g) continue;
    for (const id of [g.loadNode, g.guideNode]) if (wf[id]) problems.push(`${v}: audioGuide node id ${id} is already used`);
    for (const [name, [node]] of [["positive", g.positive], ["latent", g.latent], ["audioVae", g.audioVae]] as const) {
      if (!wf[node]) problems.push(`${v}: audioGuide ${name} source node ${node} missing`);
    }
    if (!(g.consumer[1] in (wf[g.consumer[0]]?.inputs ?? {}))) problems.push(`${v}: audioGuide consumer ${g.consumer.join(".")} does not exist`);
  }
  if (problems.length) {
    throw new ColabComfyError(EXIT.io, [{ code: "io", message: `template ${tpl.name} is inconsistent: ${problems.join("; ")}` }]);
  }
}

export function variantFor(sparsity: number): Variant {
  return sparsity === 0 ? "dense" : "vsa";
}

export interface BindInput {
  prompt: string;
  width: number;
  height: number;
  frames: number;
  seed: number;
  sparsity: number;
}

export interface Bound {
  variant: Variant;
  /** sha256 of the variant file the workflow was derived from (cache-key input). */
  templateFileSha256: string;
  workflow: WorkflowJson;
}

/** Output prefix used while computing keys; the VM runner replaces it with fk/<cacheKey>. */
export const KEY_OUTPUT_PREFIX = "fk/out";

export function bindWorkflow(tpl: Template, input: BindInput, candidate: number, inputs: ResolvedInputs): Bound {
  const { refs, audio, image } = inputs;
  const variant = variantFor(input.sparsity);
  const src = tpl.variants[variant];
  if (!src) throw new Error(`bindWorkflow: template ${tpl.name} has no ${variant} variant`);
  const wf = structuredClone(src.workflow);
  const set = ([node, name]: [string, string], value: unknown): void => {
    wf[node]!.inputs[name] = value;
  };
  const b = tpl.bindings.bind;
  set(b.prompt, input.prompt);
  set(b.width, input.width);
  set(b.height, input.height);
  set(b.frames, input.frames);
  set(b.seed, input.seed + candidate);
  set(b.outputPrefix, KEY_OUTPUT_PREFIX);
  if (variant === "vsa") set(b.sparsity!, input.sparsity);

  if (tpl.bindings.firstFrame) {
    if (!image || refs.length) throw new Error(`bindWorkflow: template ${tpl.name} takes exactly one first-frame image and no refs`);
    wf[tpl.bindings.firstFrame.loadNode]!.inputs.image = `${image.sha256}.${image.ext}`;
  }
  if (tpl.bindings.refs) {
    if (image) throw new Error(`bindWorkflow: template ${tpl.name} takes refs, not a first-frame image`);
    if (refs.length < 1 || refs.length > tpl.bindings.refs.max) {
      throw new Error(`bindWorkflow: need 1..${tpl.bindings.refs.max} refs, got ${refs.length}`);
    }
  }
  const { loadNode, target, inputPattern, indexBase } = tpl.bindings.refs ?? { loadNode: "", target: "", inputPattern: "", indexBase: 0 };
  refs.forEach((ref, i) => {
    const id = String(Number(loadNode) + i);
    const filename = `${ref.sha256}.${ref.ext}`;
    if (i === 0) {
      wf[id]!.inputs.image = filename;
    } else {
      wf[id] = { ...structuredClone(wf[loadNode]!), inputs: { ...wf[loadNode]!.inputs, image: filename } };
      wf[target]!.inputs[inputPattern.replace("{i}", String(indexBase + i))] = [id, 0];
    }
  });

  if (tpl.bindings.audio) {
    // Built-in guide (h3-fl2va): only the file name is bound. Content-hashed, so the bytes are in the cache key.
    if (!audio) throw new Error(`bindWorkflow: template ${tpl.name} needs the driving audio`);
    wf[tpl.bindings.audio.loadNode]!.inputs.audio = `${audio.sha256}.${audio.ext}`;
  } else if (audio) {
    // The content-hashed filename puts the audio bytes into the workflow, hence into the cache key.
    const g = tpl.bindings.audioGuide;
    if (!g) throw new Error(`bindWorkflow: template ${tpl.name} has no audioGuide binding`);
    wf[g.loadNode] = { class_type: "LoadAudio", inputs: { audio: `${audio.sha256}.${audio.ext}` } };
    wf[g.guideNode] = {
      class_type: "MiniMaxH3AddGuide",
      inputs: { positive: [...g.positive], latent: [...g.latent], frame_idx: g.frameIdx, audio_vae: [...g.audioVae], audio: [g.loadNode, 0] },
    };
    wf[g.consumer[0]]!.inputs[g.consumer[1]] = [g.guideNode, 0];
  }
  return { variant, templateFileSha256: src.fileSha256, workflow: wf };
}

/** Smallest valid `length` (min + step·k) that covers `duration` seconds at `fps`. */
export function framesFor(duration: number, fps: number, spec: LengthSpec): number {
  // round to 6 decimals first so 4.05*24 = 97.19999999999999 style noise cannot flip a ceil
  const wanted = Math.ceil(Math.round(duration * fps * 1e6) / 1e6);
  if (wanted <= spec.min) return spec.min;
  return spec.min + Math.ceil((wanted - spec.min) / spec.step) * spec.step;
}
