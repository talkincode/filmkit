// Template loading and workflow binding (PLAN D4/D5, §5.3).
//
// A template is an unmodified ComfyUI API JSON (two variants: dense and VSA)
// plus bindings.json naming the exact node inputs we may patch. bindWorkflow()
// deep-copies the variant and writes only those fields; the only structural
// edits are the variant choice and the extra LoadImage nodes for ref2/ref3.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT, invalid } from "./errors.ts";

export const TEMPLATES_ROOT = join(import.meta.dir, "..", "templates");

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
  variants: Record<Variant, string>;
  bind: Record<"prompt" | "width" | "height" | "frames" | "seed" | "sparsity" | "outputPrefix", [string, string]>;
  refs: { loadNode: string; target: string; inputPattern: string; indexBase: number; max: number };
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
  objectInfo: {
    classes: {
      MiniMaxH3ReferenceToVideo: { inputs: { length: LengthSpec; width: { min: number; step: number }; height: { min: number; step: number } } };
      Ref2VAVSAGatePatch: { inputs: { sparsity: { min: number; max: number } } };
    };
  };
  variants: Record<Variant, { file: string; fileSha256: string; workflow: WorkflowJson }>;
}

export interface ResolvedRef {
  /** The path as written in the film (film-relative). */
  path: string;
  sha256: string;
  ext: "png" | "jpg" | "webp";
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
  for (const v of ["dense", "vsa"] as const) {
    for (const [key, [node, input]] of Object.entries(tpl.bindings.bind)) {
      if (key === "sparsity" && v === "dense") continue;
      if (!(input in (tpl.variants[v].workflow[node]?.inputs ?? {}))) problems.push(`${v}: binding ${key} -> ${node}.${input} does not exist`);
    }
    const { loadNode, target } = tpl.bindings.refs;
    if (tpl.variants[v].workflow[loadNode]?.class_type !== "LoadImage") problems.push(`${v}: node ${loadNode} is not a LoadImage`);
    if (!tpl.variants[v].workflow[target]) problems.push(`${v}: ref target node ${target} missing`);
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

export function bindWorkflow(tpl: Template, input: BindInput, candidate: number, refs: ResolvedRef[]): Bound {
  if (refs.length < 1 || refs.length > tpl.bindings.refs.max) {
    throw new Error(`bindWorkflow: need 1..${tpl.bindings.refs.max} refs, got ${refs.length}`);
  }
  const variant = variantFor(input.sparsity);
  const src = tpl.variants[variant];
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
  if (variant === "vsa") set(b.sparsity, input.sparsity);

  const { loadNode, target, inputPattern, indexBase } = tpl.bindings.refs;
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
  return { variant, templateFileSha256: src.fileSha256, workflow: wf };
}

/** Smallest valid `length` (min + step·k) that covers `duration` seconds at `fps`. */
export function framesFor(duration: number, fps: number, spec: LengthSpec): number {
  // round to 6 decimals first so 4.05*24 = 97.19999999999999 style noise cannot flip a ceil
  const wanted = Math.ceil(Math.round(duration * fps * 1e6) / 1e6);
  if (wanted <= spec.min) return spec.min;
  return spec.min + Math.ceil((wanted - spec.min) / spec.step) * spec.step;
}
