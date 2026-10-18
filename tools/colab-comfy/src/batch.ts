// `colab-comfy batch`: plan -> jobs -> cache lookup -> estimate -> gate.
// This milestone implements the free, offline half (`--estimate`); the Colab
// session lifecycle lands in a later milestone. Nothing here calls `colab`.

import { dirname, resolve } from "node:path";
import { cacheHit, jobCacheKey } from "./cache.ts";
import { ColabComfyError, EXIT, type Detail } from "./errors.ts";
import { estimateCU, loadEstimates, type Breakdown, type EstimateJob } from "./estimate.ts";
import { decide, type GateResult } from "./gate.ts";
import { jobFrames, normalizeJob, resolveRefs, validateJob, variantKey, type Job } from "./job.ts";
import { loadTemplate, type Template } from "./workflow.ts";

/** The subset of `filmkit plan --json` this helper reads. */
export interface PlanJson {
  film: string;
  nodes: {
    id: string;
    status: string;
    profile: { name: string };
    task: string;
    params: Record<string, unknown>;
    inputs: Record<string, string | undefined>;
  }[];
}

export const PROFILE_NAME = "colab-comfy";
/** Statuses that need (re)production; `ready` never appears in a plan and `blocked` waits on upstream. */
const PENDING = new Set(["missing", "partial", "stale"]);

/**
 * Run `<filmkit> plan --json --film F`. The command string is split on
 * whitespace (COLAB_COMFY_FILMKIT="bun /path/bin/filmkit.ts"); no shell is used.
 */
export async function runFilmkitPlan(filmkitCmd: string, film: string, cwd: string): Promise<PlanJson> {
  const argv = [...filmkitCmd.trim().split(/\s+/), "plan", "--json", "--film", film];
  let proc;
  try {
    proc = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    throw new ColabComfyError(EXIT.missingDependency, [
      { code: "missing-dependency", message: `cannot run "${argv[0]}": ${(err as Error).message}`, hint: "install filmkit or set COLAB_COMFY_FILMKIT" },
    ]);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new ColabComfyError(([EXIT.io, EXIT.invalidInput, EXIT.missingDependency] as number[]).includes(code) ? code : EXIT.toolFailure, [
      { code: "filmkit-plan-failed", message: `${argv.join(" ")} exited ${code}${tail ? `:\n${tail}` : ""}` },
    ]);
  }
  try {
    return JSON.parse(stdout) as PlanJson;
  } catch {
    throw new ColabComfyError(EXIT.toolFailure, [{ code: "filmkit-plan-failed", message: "filmkit plan --json did not print JSON" }]);
  }
}

export interface Candidate {
  index: number;
  seed: number;
  key: string;
  cached: boolean;
}

export interface SelectedNode {
  id: string;
  status: string;
  job: Job;
  template: Template;
  frames: number;
  variant: string;
  candidates: Candidate[];
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface Collected {
  selected: SelectedNode[];
  skipped: Skipped[];
}

/**
 * Plan -> jobs (PLAN §5.4 batch steps 1-2).
 *
 * Decision (cost): when `pick` is set only that candidate is needed to
 * materialize, so only it is expanded; generating the others again would spend
 * CU for clips nothing will reference. Without `pick`, all `candidates` seeds
 * are expanded.
 */
export function collectJobs(plan: PlanJson, baseDir: string, only?: string[]): Collected {
  const planIds = new Set(plan.nodes.map((n) => n.id));
  const selected: SelectedNode[] = [];
  const skipped: Skipped[] = [];
  const problems: Detail[] = [];
  const templates = new Map<string, Template>();

  for (const n of plan.nodes) {
    if (n.profile.name !== PROFILE_NAME) continue;
    if (only && !only.includes(n.id)) continue;
    if (n.status === "blocked") {
      skipped.push({ id: n.id, reason: "blocked: an input node is not ready" });
      continue;
    }
    if (!PENDING.has(n.status)) {
      skipped.push({ id: n.id, reason: `status ${n.status}` });
      continue;
    }
    const upstream = Object.keys(n.inputs).filter((i) => planIds.has(i));
    if (upstream.length) {
      skipped.push({ id: n.id, reason: `waiting for upstream node(s): ${upstream.join(", ")}` });
      continue;
    }

    try {
      const job = normalizeJob({ ...n.params, node: n.id });
      let tpl = templates.get(job.template);
      if (!tpl) templates.set(job.template, (tpl = loadTemplate(job.template)));
      const bad = validateJob(job, { baseDir, tpl });
      if (bad.length) {
        problems.push(...bad.map((d) => ({ ...d, field: `${n.id}.${d.field ?? ""}`.replace(/\.$/, "") })));
        continue;
      }
      const refs = resolveRefs(job, baseDir);
      const indexes = job.pick !== undefined ? [job.pick] : Array.from({ length: job.candidates }, (_, i) => i);
      const candidates = indexes.map((index): Candidate => {
        const key = jobCacheKey(tpl!, job, index, refs);
        return { index, seed: job.seed + index, key, cached: cacheHit(baseDir, key) };
      });
      selected.push({ id: n.id, status: n.status, job, template: tpl, frames: jobFrames(job, tpl), variant: variantKey(job), candidates });
    } catch (err) {
      if (!(err instanceof ColabComfyError)) throw err;
      problems.push(...err.details.map((d) => ({ ...d, field: `${n.id}.${d.field ?? ""}`.replace(/\.$/, "") })));
    }
  }
  for (const id of only ?? []) {
    if (!plan.nodes.some((n) => n.id === id)) skipped.push({ id, reason: "not pending (ready, unknown, or not in the plan)" });
  }
  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  return { selected, skipped };
}

export interface EstimateOptions {
  /** Relative paths (film) resolve against cwd, like every filmkit command. */
  cwd: string;
  film: string;
  nodes?: string[];
  filmkit: string;
  gpu: string;
  rate?: number;
  budgetCU: number;
  yes: boolean;
}

export interface EstimateReport {
  ok: true;
  mode: "estimate";
  film: string;
  gpu: string;
  nodes: { id: string; status: string; variant: string; width: number; height: number; frames: number; candidates: Candidate[] }[];
  skipped: Skipped[];
  jobsToGenerate: number;
  jobsCached: number;
  budgetCU: number;
  estimate: Breakdown;
  gate: GateResult;
}

/** `batch --estimate`: no `colab` call of any kind. Exit 0, or 5 when confirmation would be needed. */
export async function batchEstimate(opts: EstimateOptions): Promise<{ report: EstimateReport; exitCode: number }> {
  const baseDir = dirname(resolve(opts.cwd, opts.film));
  const plan = await runFilmkitPlan(opts.filmkit, opts.film, opts.cwd);
  const { selected, skipped } = collectJobs(plan, baseDir, opts.nodes);

  const misses: EstimateJob[] = [];
  let cached = 0;
  for (const s of selected) {
    for (const c of s.candidates) {
      if (c.cached) cached++;
      else misses.push({ node: s.id, candidate: c.index, variant: s.variant, width: s.job.width, height: s.job.height, frames: s.frames });
    }
  }
  const estimate = estimateCU(misses, loadEstimates(), { gpu: opts.gpu, rate: opts.rate });
  const gate = decide({
    jobs: misses.length,
    estimateCU: estimate.cu,
    budgetCU: opts.budgetCU,
    yes: opts.yes,
    gpu: opts.gpu,
    rateExplicit: opts.rate !== undefined,
  });
  const report: EstimateReport = {
    ok: true,
    mode: "estimate",
    film: opts.film,
    gpu: opts.gpu,
    nodes: selected.map((s) => ({ id: s.id, status: s.status, variant: s.variant, width: s.job.width, height: s.job.height, frames: s.frames, candidates: s.candidates })),
    skipped,
    jobsToGenerate: misses.length,
    jobsCached: cached,
    budgetCU: opts.budgetCU,
    estimate,
    gate,
  };
  return { report, exitCode: gate.decision === "proceed" ? EXIT.ok : EXIT.needsConfirmation };
}

export function formatEstimate(r: EstimateReport): string {
  const lines: string[] = [`film: ${r.film}`];
  if (r.nodes.length === 0 && r.skipped.length === 0) lines.push("no pending colab-comfy nodes");
  for (const n of r.nodes) {
    lines.push(`${n.id} (${n.status}): ${n.variant} ${n.width}x${n.height} ${n.frames}f`);
    for (const c of n.candidates) lines.push(`  candidate ${c.index} seed ${c.seed} key ${c.key.slice(0, 12)} ${c.cached ? "cached" : "to generate"}`);
  }
  for (const s of r.skipped) lines.push(`skipped ${s.id}: ${s.reason}`);
  if (r.jobsToGenerate === 0) {
    lines.push(r.nodes.length ? "nothing to generate: every needed clip is cached (0 CU)" : "nothing to generate (0 CU)");
    return lines.join("\n");
  }
  const e = r.estimate;
  lines.push(
    `estimate: ${e.cu.toFixed(2)} CU for ${r.jobsToGenerate} job(s) (${r.jobsCached} cached) on ${e.gpu} @ ${e.rateCuPerHour} CU/h (${e.rateSource}), margin ${e.margin}, budget ${r.budgetCU.toFixed(2)} CU`,
    `  fixed ${e.fixedSec.startup + e.fixedSec.firstLoad + e.fixedSec.teardown}s (startup ${e.fixedSec.startup} + first load ${e.fixedSec.firstLoad} + teardown ${e.fixedSec.teardown})`,
  );
  for (const j of e.jobs) lines.push(`  ${j.node}#${j.candidate} ${j.variant}: generate ${j.genSec}s (scale ${j.scale}) + download ${j.downloadSec}s`);
  lines.push(`  total ${e.totalSec}s`);
  if (r.gate.decision === "proceed") lines.push("gate: proceed");
  else {
    lines.push("gate: needs confirmation (exit 5)");
    for (const g of r.gate.reasons) lines.push(`  - ${g.message}\n    hint: ${g.hint}`);
  }
  return lines.join("\n");
}
