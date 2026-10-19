// Host-side payload builder: jobs.json + the tar.gz bundle the VM kick script extracts (PLAN §5.5).
//
// buildJobsDoc() turns selected nodes into the `colab-comfy/v1` jobs document. It resolves the SAME
// bound workflow the cache key was computed from and refuses to continue if the recomputed key differs
// from the one batch announced, so a clip can never land in the cache under a key that does not
// describe its content. The top-level `requiredClasses` (from the template's bindings.json) is what the
// VM runner asserts against /object_info before submitting anything (M3 review item).
//
// Nothing secret goes into jobs.json. `secrets.env` (optional, 0600) is only ever a separate bundle
// member; M0 A3 forbids sending secrets via `colab exec --env`.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SelectedNode } from "./batch.ts";
import { cacheKey, PROTOCOL } from "./cache.ts";
import { sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT } from "./errors.ts";
import { bindInput, resolveInputs } from "./job.ts";
import { bindWorkflow, type Manifest, type WorkflowJson } from "./workflow.ts";

export const VM_DIR = join(import.meta.dir, "..", "vm");

export interface Limits {
  setupTimeoutSec: number;
  comfyStartTimeoutSec: number;
  jobTimeoutSec: number;
  idleTtlSec: number;
  /** Epoch seconds; the VM watchdog self-releases after it (PLAN §6.3). */
  hardDeadlineEpoch?: number;
}

export const DEFAULT_LIMITS: Omit<Limits, "hardDeadlineEpoch"> = {
  setupTimeoutSec: 1800,
  comfyStartTimeoutSec: 300,
  jobTimeoutSec: 900,
  idleTtlSec: 600,
};

export interface JobEntry {
  key: string;
  node: string;
  candidate: number;
  seed: number;
  frames: number;
  width: number;
  height: number;
  variant: string;
  inputs: { file: string; sha256: string }[];
  workflow: WorkflowJson;
}

export interface JobsDoc {
  protocol: typeof PROTOCOL;
  session: string;
  manifest: Manifest;
  manifestSha256: string;
  requiredClasses: string[];
  limits: Limits;
  jobs: JobEntry[];
}

export interface BuiltJobs {
  doc: JobsDoc;
  /** bundle member name (`<sha>.<ext>`) -> absolute path of the reference image / audio guide on the host. */
  inputs: Map<string, string>;
}

export interface BuildJobsOptions {
  session: string;
  nodes: SelectedNode[];
  /** Film directory: refs are film-relative. */
  baseDir: string;
  limits?: Partial<Limits>;
}

/** Jobs for every candidate that is not cached yet, in plan order (node, then candidate). */
export function buildJobsDoc(opts: BuildJobsOptions): BuiltJobs {
  const templates = new Set(opts.nodes.map((n) => n.template.name));
  if (templates.size > 1) {
    throw new ColabComfyError(EXIT.invalidInput, [
      { code: "invalid-input", message: `one session runs one template; got ${[...templates].join(", ")}`, hint: "split the batch with --nodes" },
    ]);
  }
  const jobs: JobEntry[] = [];
  const bundled = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (const n of opts.nodes) {
    const tpl = n.template;
    const inputs = resolveInputs(n.job, opts.baseDir);
    const files = [...inputs.refs, ...(inputs.audio ? [inputs.audio] : [])];
    for (const c of n.candidates) {
      if (c.cached) continue;
      const bound = bindWorkflow(tpl, bindInput(n.job, tpl), c.index, inputs);
      const key = cacheKey(tpl, bound);
      if (key !== c.key) {
        throw new ColabComfyError(EXIT.toolFailure, [
          { code: "key-mismatch", message: `node ${n.id} candidate ${c.index}: recomputed cache key ${key} differs from ${c.key}`, hint: "an input file changed while the batch was being prepared" },
        ]);
      }
      if (seenKeys.has(key)) continue; // identical content under two nodes: generate once, materialize twice
      seenKeys.add(key);
      for (const f of files) bundled.set(`${f.sha256}.${f.ext}`, resolve(opts.baseDir, f.path));
      jobs.push({
        key,
        node: n.id,
        candidate: c.index,
        seed: n.job.seed + c.index,
        frames: n.frames,
        width: n.job.width,
        height: n.job.height,
        variant: n.variant,
        inputs: files.map((f) => ({ file: `${f.sha256}.${f.ext}`, sha256: f.sha256 })),
        workflow: bound.workflow,
      });
    }
  }
  if (jobs.length === 0) {
    throw new ColabComfyError(EXIT.invalidInput, [{ code: "invalid-input", message: "no jobs to generate: every candidate is cached" }]);
  }
  const tpl = opts.nodes[0]!.template;
  const doc: JobsDoc = {
    protocol: PROTOCOL,
    session: opts.session,
    manifest: tpl.manifest,
    manifestSha256: tpl.manifestSha256,
    // LoadAudio + MiniMaxH3AddGuide are checked on the VM only when some job uses them.
    requiredClasses: [...tpl.bindings.requiredClasses, ...(tpl.bindings.audioGuide && jobs.some((j) => j.workflow[tpl.bindings.audioGuide!.guideNode]) ? tpl.bindings.audioGuide.requiredClasses : [])],
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    jobs,
  };
  return { doc, inputs: bundled };
}

export interface WriteBundleOptions {
  built: BuiltJobs;
  /** Final path; written as <path>.part then renamed (no half-written bundle). */
  outFile: string;
  /** Optional secrets.env content (0600 inside the bundle). Never logged, never in jobs.json. */
  secretsEnv?: string;
  vmDir?: string;
}

async function tar(args: string[]): Promise<void> {
  let p;
  try {
    p = Bun.spawn(["tar", ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    throw new ColabComfyError(EXIT.missingDependency, [{ code: "missing-dependency", message: `cannot run tar: ${(err as Error).message}` }]);
  }
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new ColabComfyError(EXIT.io, [{ code: "io", message: `tar failed (${code}): ${stderr.trim()}` }]);
}

/** Stage vm/*.py + jobs.json + manifest.json + inputs/, tar it, rename into place. */
export async function writeBundle(opts: WriteBundleOptions): Promise<void> {
  const vmDir = opts.vmDir ?? VM_DIR;
  const stage = mkdtempSync(join(tmpdir(), "colab-comfy-bundle-"));
  const part = `${opts.outFile}.part`;
  try {
    mkdirSync(join(stage, "vm"));
    mkdirSync(join(stage, "inputs"));
    const scripts = readdirSync(vmDir).filter((f) => f.endsWith(".py")).sort();
    if (!scripts.includes("fk_runner.py")) throw new ColabComfyError(EXIT.io, [{ code: "io", message: `${vmDir} has no fk_runner.py` }]);
    for (const f of scripts) copyFileSync(join(vmDir, f), join(stage, "vm", f));
    writeFileSync(join(stage, "jobs.json"), JSON.stringify(opts.built.doc));
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(opts.built.doc.manifest));
    for (const [name, src] of [...opts.built.inputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const bytes = readFileSync(src);
      if (sha256Hex(bytes) !== name.split(".")[0]) {
        throw new ColabComfyError(EXIT.io, [{ code: "io", message: `${src} changed on disk since it was hashed` }]);
      }
      writeFileSync(join(stage, "inputs", name), bytes);
    }
    if (opts.secretsEnv !== undefined) {
      const p = join(stage, "secrets.env");
      writeFileSync(p, opts.secretsEnv, { mode: 0o600 });
      chmodSync(p, 0o600);
    }
    mkdirSync(dirname(opts.outFile), { recursive: true });
    await tar(["-C", stage, "-czf", part, "."]);
    renameSync(part, opts.outFile);
  } finally {
    rmSync(part, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
