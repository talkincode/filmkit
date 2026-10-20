// `colab-comfy materialize` (PLAN §5.4): the Profile's `invocation`, run by `filmkit run <id>`.
// Turns a cached clip into the node's `produces` (video + run record). Free: it never calls `colab`, except
// on a cache miss when COLAB_COMFY_YES is set, which runs ONE job through the same estimate/gate/session code
// as `batch` (no second implementation of spending).
//
// Keys come from cache.jobKeyInfo(), the function batch uses, so a clip batch downloaded is found here.
// Outputs are written as <path>.part and renamed only when everything (record bytes included) is ready, so a
// failure leaves neither a half-written target nor a record without a clip.

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { filmMeta, generate, sessionProblems } from "./batch.ts";
import { cacheHit, cachePaths, jobKeyInfo, readMeta } from "./cache.ts";
import { sha256File } from "./canonical.ts";
import { ColabComfyError, EXIT, invalid, type Detail } from "./errors.ts";
import { estimateCU, loadEstimates } from "./estimate.ts";
import { DEFAULT_GPU, decide } from "./gate.ts";
import { estimateKey, jobFrames, normalizeJob, resolveInputs, usesAudioGuideSplice, validateJob, variantKey } from "./job.ts";
import { buildRecord } from "./record.ts";
import { loadTemplate } from "./workflow.ts";

export interface MaterializeOptions {
  /** Raw job flags (strings from argv); `node` names the scene. */
  flags: Record<string, unknown>;
  out: string | undefined;
  record: string | undefined;
  /** Only used for the session name/ledger of a COLAB_COMFY_YES spend. Default ./filmkit.yaml. */
  film: string;
  /** filmkit runs the Profile invocation with cwd = the film directory. */
  cwd: string;
  budgetCU: number;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface MaterializeReport {
  ok: true;
  node: string | null;
  winner: { index: number; seed: number; cacheKey: string };
  out: string;
  record: string;
  /** true when this call ran a Colab session (COLAB_COMFY_YES on a cache miss). */
  spent: boolean;
  session?: string;
}

const truthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

function rmPart(path: string): void {
  rmSync(`${path}.part`, { force: true });
}

export async function materialize(o: MaterializeOptions): Promise<{ report: MaterializeReport; stderr: string }> {
  const job = normalizeJob(o.flags); // throws exit 2
  const tpl = loadTemplate(job.template);
  const missing: Detail[] = [];
  if (o.out === undefined) missing.push(invalid("--out is required", "out"));
  if (o.record === undefined) missing.push(invalid("--record is required", "record"));
  const problems = [...missing, ...validateJob(job, { baseDir: o.cwd, tpl, out: o.out, record: o.record })];
  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  const out = resolve(o.cwd, o.out!);
  const recordPath = resolve(o.cwd, o.record!);

  const inputs = resolveInputs(job, o.cwd);
  const infos = Array.from({ length: job.candidates }, (_, index) => ({ index, seed: job.seed + index, ...jobKeyInfo(tpl, job, index, inputs) }));

  // Step 2: several candidates need a human/agent decision; list where to look.
  if (job.candidates > 1 && job.pick === undefined) {
    const list = infos.map((c) => `candidate ${c.index} (seed ${c.seed}): ${relative(o.cwd, cachePaths(o.cwd, c.key).clip)}${cacheHit(o.cwd, c.key) ? "" : " [not generated]"}`);
    throw new ColabComfyError(EXIT.invalidInput, [
      {
        code: "needs-pick",
        message: `${job.node ?? "node"} has ${job.candidates} candidates and no params.pick`,
        field: "pick",
        hint: `review the clips, set params.pick to the winning index, then run filmkit run again (0 CU):\n  ${list.join("\n  ")}`,
      },
    ]);
  }

  const winner = infos[job.pick ?? 0]!;
  let spent = false;
  let session: string | undefined;
  const stderr: string[] = [];

  // Step 3: cache miss.
  if (!cacheHit(o.cwd, winner.key)) {
    const frames = jobFrames(job, tpl);
    const jobEstimate = { node: job.node ?? "job", candidate: winner.index, variant: estimateKey(job, tpl), width: job.width, height: job.height, frames, audioGuide: usesAudioGuideSplice(job, tpl) };
    const est = estimateCU([jobEstimate], loadEstimates(), { gpu: DEFAULT_GPU });
    const id = job.node ?? "<id>";
    if (!truthy(o.env.COLAB_COMFY_YES)) {
      throw new ColabComfyError(EXIT.needsConfirmation, [
        {
          code: "needs-confirmation",
          message: `${id}: the clip is not generated yet (cache miss)`,
          hint: `≈${est.cu.toFixed(2)} CU for 1 job; prefer \`colab-comfy batch\` (one session for all nodes); or authorize this spend with COLAB_COMFY_YES=1 filmkit run ${id}`,
        },
      ]);
    }
    // COLAB_COMFY_YES is the confirmation; the budget cap still applies (yes never raises it).
    const gate = decide({ jobs: 1, estimateCU: est.cu, budgetCU: o.budgetCU, yes: true, gpu: DEFAULT_GPU, rateExplicit: false });
    if (gate.decision !== "proceed") {
      throw new ColabComfyError(EXIT.needsConfirmation, gate.reasons.map((r): Detail => ({ code: r.code, message: `${id}: ${r.message}`, hint: r.hint })));
    }
    // Spend through the shared batch path. Jobs come from these flags, not from `filmkit plan`.
    let meta: { name: string; sha256?: string };
    try {
      meta = filmMeta(resolve(o.cwd, o.film));
    } catch (err) {
      if (!(err instanceof ColabComfyError)) throw err;
      meta = { name: job.node ?? "film" }; // `filmkit run` did not tell us the film file; the name is cosmetic
    }
    const result = await generate({
      baseDir: o.cwd,
      film: o.film,
      filmName: meta.name,
      filmSha256: meta.sha256,
      gpu: DEFAULT_GPU,
      budgetCU: o.budgetCU,
      estimate: est,
      nodes: [
        {
          id,
          status: "missing",
          job,
          template: tpl,
          frames,
          variant: variantKey(job),
          candidates: [{ index: winner.index, seed: winner.seed, key: winner.key, cached: false }],
        },
      ],
      env: o.env,
      log: o.log,
    });
    spent = true;
    session = result.session;
    stderr.push(...sessionProblems(result));
    if (!cacheHit(o.cwd, winner.key)) {
      const code = result.exitCode !== EXIT.ok ? result.exitCode : EXIT.toolFailure;
      throw new ColabComfyError(code, [{ code: "generation-failed", message: `${id}: session ${result.session} ended ${result.outcome}; no clip was produced`, hint: stderr.join("\n") || undefined }]);
    }
  }

  // Step 4: build everything in memory/.part first, then rename.
  const cache = cachePaths(o.cwd, winner.key);
  let recordBytes: string;
  try {
    const meta = readMeta(o.cwd, winner.key);
    if (sha256File(cache.clip) !== meta.video.sha256) {
      throw new Error(`clip ${cache.clip} does not match the sha256 in its meta.json`);
    }
    recordBytes = buildRecord({ baseDir: o.cwd, job, tpl, winner: winner.index });
  } catch (err) {
    throw new ColabComfyError(EXIT.io, [{ code: "io", message: (err as Error).message, hint: `delete ${dirname(cache.clip)} and re-run to regenerate it` }]);
  }
  try {
    mkdirSync(dirname(out), { recursive: true });
    mkdirSync(dirname(recordPath), { recursive: true });
    copyFileSync(cache.clip, `${out}.part`);
    writeFileSync(`${recordPath}.part`, recordBytes);
    renameSync(`${out}.part`, out);
    try {
      renameSync(`${recordPath}.part`, recordPath);
    } catch (err) {
      // never leave a video without its record from this call
      if (!existsSync(recordPath)) rmSync(out, { force: true });
      throw err;
    }
  } catch (err) {
    rmPart(out);
    rmPart(recordPath);
    throw new ColabComfyError(EXIT.io, [{ code: "io", message: `could not write produces: ${(err as Error).message}` }]);
  }
  return {
    report: { ok: true, node: job.node ?? null, winner: { index: winner.index, seed: winner.seed, cacheKey: winner.key }, out: o.out!, record: o.record!, spent, ...(session ? { session } : {}) },
    stderr: stderr.length ? stderr.join("\n") + "\n" : "",
  };
}
