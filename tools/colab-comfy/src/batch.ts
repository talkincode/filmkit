// `colab-comfy batch` (PLAN §5.4): plan -> jobs -> cache lookup -> estimate -> gate -> [lock -> session
// lifecycle -> ledger] -> materialize. `batchEstimate` is the free, offline half and never calls `colab`;
// `runBatch` adds steps 5-7 and 9 (the session lives in session.ts). Step 8 runs `filmkit run <id>` per node, which
// calls `colab-comfy materialize` (src/materialize.ts) over the freshly filled cache: free, no `colab` call.
// `generate()` (steps 5-7 for an already gated job list) is shared with materialize's COLAB_COMFY_YES path.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { cacheHit, cachePaths, jobCacheKey } from "./cache.ts";
import { sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT, invalid, type Detail } from "./errors.ts";
import { chooseGpu, estimateCU, isCalibrated, loadEstimates, type Breakdown, type EstimateJob } from "./estimate.ts";
import { decide, GPU_AUTO, type GateResult } from "./gate.ts";
import { jobFrames, normalizeJob, resolveRefs, validateJob, variantKey, type Job } from "./job.ts";
import { acquireBatchLock, stateDir } from "./ledger.ts";
import { runSession, sessionName, type SessionResult } from "./session.ts";
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
export async function runFilmkitPlan(filmkitCmd: string, film: string, cwd: string, env: Record<string, string | undefined> = process.env): Promise<PlanJson> {
  const argv = [...filmkitCmd.trim().split(/\s+/), "plan", "--json", "--film", film];
  let proc;
  try {
    proc = Bun.spawn(argv, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
  /** Environment for the `filmkit plan` child; default process.env. */
  env?: Record<string, string | undefined>;
}

export interface GpuChoice {
  requested: string;
  chosen: string;
  candidates: { gpu: string; cu: number; totalSec: number }[];
  fallback: { gpu: string; cu: number } | null;
}

export interface EstimateReport {
  ok: boolean;
  mode: "estimate" | "batch";
  film: string;
  /** The GPU the estimate is for (the chosen one under `--gpu auto`). */
  gpu: string;
  /** As given: `auto` (default), `L4`, `A100`, ... */
  gpuRequested: string;
  /** `--gpu auto` only: every auto GPU's estimate and the fallback, else null. */
  gpuChoice: GpuChoice | null;
  nodes: { id: string; status: string; variant: string; width: number; height: number; frames: number; candidates: Candidate[] }[];
  skipped: Skipped[];
  jobsToGenerate: number;
  jobsCached: number;
  budgetCU: number;
  estimate: Breakdown;
  gate: GateResult;
}

interface Prepared {
  baseDir: string;
  selected: SelectedNode[];
  skipped: Skipped[];
  misses: EstimateJob[];
  cached: number;
  estimate: Breakdown;
  /** `--gpu auto` only: what to open when `colab new` cannot get the chosen GPU (fits the budget), else null. */
  fallback: Breakdown | null;
  gate: GateResult;
  report: EstimateReport;
}

/** Batch steps 1-4: plan, jobs, cache lookup, estimate, gate. Free and offline. */
async function prepare(opts: EstimateOptions, mode: EstimateReport["mode"]): Promise<Prepared> {
  const baseDir = dirname(resolve(opts.cwd, opts.film));
  const plan = await runFilmkitPlan(opts.filmkit, opts.film, opts.cwd, opts.env);
  const { selected, skipped } = collectJobs(plan, baseDir, opts.nodes);

  const misses: EstimateJob[] = [];
  let cached = 0;
  for (const s of selected) {
    for (const c of s.candidates) {
      if (c.cached) cached++;
      else misses.push({ node: s.id, candidate: c.index, variant: s.variant, width: s.job.width, height: s.job.height, frames: s.frames });
    }
  }
  const cfg = loadEstimates();
  let estimate: Breakdown;
  let gpuChoice: GpuChoice | null = null;
  let fallback: Breakdown | null = null;
  if (opts.gpu === GPU_AUTO) {
    if (opts.rate !== undefined) {
      throw new ColabComfyError(EXIT.invalidInput, [invalid("--rate applies to one GPU; it cannot be combined with --gpu auto", "rate", "pass an explicit --gpu (e.g. --gpu A100 --rate 5.3), or drop --rate")]);
    }
    const c = chooseGpu(misses, cfg, opts.budgetCU);
    estimate = c.estimate;
    fallback = c.fallback;
    gpuChoice = { requested: GPU_AUTO, chosen: c.gpu, candidates: c.candidates, fallback: fallback ? { gpu: fallback.gpu, cu: fallback.cu } : null };
  } else {
    estimate = estimateCU(misses, cfg, { gpu: opts.gpu, rate: opts.rate });
  }
  const gate = decide({
    jobs: misses.length,
    estimateCU: estimate.cu,
    budgetCU: opts.budgetCU,
    yes: opts.yes,
    gpu: estimate.gpu,
    rateExplicit: opts.rate !== undefined,
    calibrated: isCalibrated(cfg, estimate.gpu),
  });
  const report: EstimateReport = {
    ok: gate.decision === "proceed",
    mode,
    film: opts.film,
    gpu: estimate.gpu,
    gpuRequested: opts.gpu,
    gpuChoice,
    nodes: selected.map((s) => ({ id: s.id, status: s.status, variant: s.variant, width: s.job.width, height: s.job.height, frames: s.frames, candidates: s.candidates })),
    skipped,
    jobsToGenerate: misses.length,
    jobsCached: cached,
    budgetCU: opts.budgetCU,
    estimate,
    gate,
  };
  return { baseDir, selected, skipped, misses, cached, estimate, fallback, gate, report };
}

/** `batch --estimate`: no `colab` call of any kind. Exit 0, or 5 when confirmation would be needed. */
export async function batchEstimate(opts: EstimateOptions): Promise<{ report: EstimateReport; exitCode: number }> {
  const p = await prepare(opts, "estimate");
  return { report: p.report, exitCode: p.gate.decision === "proceed" ? EXIT.ok : EXIT.needsConfirmation };
}

export interface BatchOptions extends EstimateOptions {
  /** Session name override; must start with `fk-` (reap only ever touches such names). */
  session?: string;
  maxWallSec?: number;
  noMaterialize: boolean;
  /** Progress lines; default: ignore. */
  log?: (line: string) => void;
}

export interface MaterializeNode {
  id: string;
  /**
   * materialized     `filmkit run` succeeded (produce + record written, lock updated)
   * needs-pick       candidates > 1 and no `pick`: review the clips, set `pick`, run `filmkit run <id>`
   * not-generated    a needed clip is not in the cache (its job failed or was not run); nothing was attempted
   * failed           `filmkit run` exited non-zero
   */
  status: "materialized" | "needs-pick" | "not-generated" | "failed";
  exitCode?: number;
  message?: string;
  candidates?: { index: number; seed: number; cached: boolean; cachePath: string }[];
}

export interface MaterializeSummary {
  status: "skipped" | "ok" | "failed";
  reason: string;
  nodes: MaterializeNode[];
}

export interface BatchReport extends EstimateReport {
  session: SessionResult | null;
  materialize: MaterializeSummary;
}

export interface FilmkitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `<filmkit> <args…>` (command string split on whitespace, no shell). */
export async function runFilmkit(filmkitCmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<FilmkitResult> {
  const argv = [...filmkitCmd.trim().split(/\s+/), ...args];
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  let proc;
  try {
    proc = Bun.spawn(argv, { cwd, env: clean, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    throw new ColabComfyError(EXIT.missingDependency, [{ code: "missing-dependency", message: `cannot run "${argv[0]}": ${(err as Error).message}`, hint: "install filmkit or set COLAB_COMFY_FILMKIT" }]);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** First error message of a `--json` failure (`{"errors":[{message,...}]}`), else the stderr tail. */
function failureMessage(r: FilmkitResult): string {
  try {
    const e = (JSON.parse(r.stderr) as { errors?: { message?: string; hint?: string }[] }).errors?.[0];
    if (e?.message) return e.hint ? `${e.message} (${e.hint})` : e.message;
  } catch {
    // not JSON: fall through
  }
  return r.stderr.trim().split("\n").slice(-6).join("\n") || `exited ${r.code}`;
}

/**
 * Batch step 8. Per node, so a partial session still materializes the nodes whose clips all arrived.
 * `COLAB_COMFY_YES` is removed from the children's environment: the batch's own gate already decided about
 * spending, and a materialize that finds a miss here must refuse (exit 5) rather than open a second session.
 */
async function materializeNodes(opts: BatchOptions, baseDir: string, selected: SelectedNode[]): Promise<MaterializeSummary> {
  if (opts.noMaterialize) return { status: "skipped", reason: "--no-materialize", nodes: [] };
  const env = { ...(opts.env ?? process.env), COLAB_COMFY_YES: undefined };
  const nodes: MaterializeNode[] = [];
  for (const n of selected) {
    // A clip may have landed after plan time (this very batch), so re-check the cache, not `Candidate.cached`.
    const cands = n.candidates.map((c) => ({ index: c.index, seed: c.seed, cached: cacheHit(baseDir, c.key), cachePath: relative(baseDir, cachePaths(baseDir, c.key).clip) }));
    if (n.job.candidates > 1 && n.job.pick === undefined) {
      nodes.push({ id: n.id, status: "needs-pick", candidates: cands, message: `${n.job.candidates} candidates rendered; review the clips, set params.pick, then run \`filmkit run ${n.id}\` (0 CU)` });
      continue;
    }
    if (cands.some((c) => !c.cached)) {
      nodes.push({ id: n.id, status: "not-generated", candidates: cands, message: "a needed clip is not in the cache (its generation failed or did not run)" });
      continue;
    }
    opts.log?.(`filmkit run ${n.id}`);
    const r = await runFilmkit(opts.filmkit, ["run", n.id, "--film", opts.film, "--json"], opts.cwd, env);
    if (r.code === 0) nodes.push({ id: n.id, status: "materialized" });
    else nodes.push({ id: n.id, status: "failed", exitCode: r.code, message: failureMessage(r) });
  }
  const failed = nodes.filter((x) => x.status === "failed" || x.status === "not-generated");
  return {
    status: failed.length ? "failed" : "ok",
    reason: failed.length ? `${failed.map((x) => x.id).join(", ")}: not materialized` : nodes.length ? "every ready node materialized or needs a pick" : "no pending nodes",
    nodes,
  };
}

/** Exit code contributed by step 8: a failing `filmkit run` keeps its class (1/2/3), anything else is a tool failure. */
function materializeExit(m: MaterializeSummary): number {
  const bad = m.nodes.find((x) => x.status === "failed");
  if (bad) return ([EXIT.io, EXIT.invalidInput, EXIT.missingDependency] as number[]).includes(bad.exitCode ?? -1) ? bad.exitCode! : EXIT.toolFailure;
  return m.nodes.some((x) => x.status === "not-generated") ? EXIT.toolFailure : EXIT.ok;
}

/** Name + content hash of the film file; the name is cosmetic (session name), so only a read error is fatal. */
export function filmMeta(path: string): { name: string; sha256: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ColabComfyError(EXIT.io, [{ code: "io", message: `cannot read film ${path}: ${(err as Error).message}` }]);
  }
  let name = "";
  try {
    const v = parseYaml(text) as { metadata?: { name?: unknown } } | null;
    if (typeof v?.metadata?.name === "string") name = v.metadata.name;
  } catch {
    // filmkit plan already validated the film; a name is only cosmetic
  }
  return { name: name || "film", sha256: sha256Hex(text) };
}

export interface GenerateOptions {
  baseDir: string;
  /** Film path as the user gave it (ledger) and its metadata. */
  film: string;
  filmName: string;
  filmSha256?: string;
  session?: string;
  gpu: string;
  budgetCU: number;
  estimate: Breakdown;
  /** `--gpu auto`: opened instead when `colab new` cannot get `gpu`. */
  fallback?: Breakdown | null;
  gpuRequested?: string;
  maxWallSec?: number;
  /** Nodes with at least one uncached candidate; already past the gate. */
  nodes: SelectedNode[];
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** Batch steps 5-7: validate the session name, take the project lock, run the session (it writes the ledger). */
export async function generate(o: GenerateOptions): Promise<SessionResult> {
  const name = o.session ?? sessionName(o.filmName);
  if (!name.startsWith("fk-") || !/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 40) {
    throw new ColabComfyError(EXIT.invalidInput, [
      { code: "invalid-input", message: `--session "${name}" must match fk-[a-z0-9-]*, at most 40 characters`, field: "session", hint: "reap only ever touches sessions whose name starts with fk-" },
    ]);
  }
  const release = acquireBatchLock(stateDir(o.baseDir)); // step 5
  try {
    return await runSession({
      baseDir: o.baseDir,
      name,
      film: o.film,
      filmSha256: o.filmSha256,
      gpu: o.gpu,
      budgetCU: o.budgetCU,
      estimateCU: o.estimate.cu,
      rateCuPerHour: o.estimate.rateCuPerHour,
      estimateTotalSec: o.estimate.totalSec,
      margin: o.estimate.margin,
      gpuRequested: o.gpuRequested ?? o.gpu,
      fallback: o.fallback ? { gpu: o.fallback.gpu, estimateCU: o.fallback.cu, rateCuPerHour: o.fallback.rateCuPerHour, totalSec: o.fallback.totalSec } : null,
      maxWallSec: o.maxWallSec,
      nodes: o.nodes,
      env: o.env,
      log: o.log,
    }); // steps 6-7
  } finally {
    release();
  }
}

/** Human-readable problems of a finished session (stderr lines); empty for a clean one. */
export function sessionProblems(session: SessionResult): string[] {
  const lines: string[] = [];
  if (session.leak) lines.push(`SESSION_LEAK: ${session.session} may still be running; run \`colab-comfy reap\``);
  if (session.error) lines.push(`error: ${session.error}`);
  for (const j of session.jobs) if (j.state !== "downloaded") lines.push(`job ${j.node}#${j.candidate}: ${j.state}${j.error ? ` (${j.error})` : ""}`);
  for (const w of session.warnings) lines.push(`warning: ${w}`);
  return lines;
}

/**
 * Batch steps 1-9. Exit: 0 ok, 5 needs confirmation, otherwise the session's exit code (4 / 3 / 128+signal), or
 * the class of the first failing `filmkit run`.
 */
export async function runBatch(opts: BatchOptions): Promise<{ report: BatchReport; exitCode: number; stderr: string }> {
  const env = opts.env ?? process.env;
  const p = await prepare(opts, "batch");
  const base = { ...p.report, mode: "batch" as const };
  if (p.misses.length === 0) {
    // Step 3: nothing to generate -> no session, no colab call, 0 CU; straight to step 8.
    const materialize = await materializeNodes(opts, p.baseDir, p.selected);
    const exitCode = materializeExit(materialize);
    return { report: { ...base, ok: exitCode === EXIT.ok, session: null, materialize }, exitCode, stderr: "" };
  }
  if (p.gate.decision !== "proceed") {
    const report: BatchReport = { ...base, ok: false, session: null, materialize: { status: "skipped", reason: "needs confirmation", nodes: [] } };
    return { report, exitCode: EXIT.needsConfirmation, stderr: "" };
  }

  const meta = filmMeta(resolve(opts.cwd, opts.film));
  const session = await generate({
    baseDir: p.baseDir,
    film: opts.film,
    filmName: meta.name,
    filmSha256: meta.sha256,
    session: opts.session,
    gpu: p.estimate.gpu,
    gpuRequested: opts.gpu,
    fallback: p.fallback,
    budgetCU: opts.budgetCU,
    estimate: p.estimate,
    maxWallSec: opts.maxWallSec,
    nodes: p.selected,
    env,
    log: opts.log,
  });
  const stderr = sessionProblems(session);

  // Step 8 also runs after a partial/failed session (clips that did arrive are cached and cost nothing to
  // materialize). Not after a signal (exit promptly) and not after a leak (nothing else should happen).
  const materialize: MaterializeSummary =
    session.leak || session.outcome === "interrupted"
      ? { status: "skipped", reason: `session ${session.leak ? "leaked" : "interrupted"}`, nodes: [] }
      : await materializeNodes(opts, p.baseDir, p.selected);
  for (const n of materialize.nodes) if (n.status === "failed") stderr.push(`filmkit run ${n.id}: ${n.message ?? "failed"}`);
  const exitCode = session.exitCode !== EXIT.ok ? session.exitCode : materializeExit(materialize);
  const report: BatchReport = { ...base, ok: exitCode === EXIT.ok, session, materialize };
  return { report, exitCode, stderr: stderr.length ? stderr.join("\n") + "\n" : "" };
}

function formatMaterialize(m: MaterializeSummary): string[] {
  const lines = [`materialize: ${m.status} (${m.reason})`];
  for (const n of m.nodes) {
    lines.push(`  ${n.id}: ${n.status}${n.message ? ` - ${n.message}` : ""}`);
    if (n.status === "needs-pick") for (const c of n.candidates ?? []) lines.push(`    candidate ${c.index} seed ${c.seed}: ${c.cachePath}${c.cached ? "" : " (missing)"}`);
  }
  return lines;
}

export function formatBatch(r: BatchReport): string {
  if (!r.session) {
    if (r.gate.decision !== "proceed") return formatEstimate(r);
    return [formatEstimate(r), ...formatMaterialize(r.materialize)].join("\n");
  }
  const s = r.session;
  const lines = [
    `session ${s.session}: ${s.outcome}${s.abortReason ? ` (${s.abortReason})` : ""}; ${s.jobsOk}/${s.jobsTotal} job(s) cached`,
    ...s.jobs.map((j) => `  ${j.node}#${j.candidate}: ${j.state}${j.cachePath ? ` -> ${j.cachePath}` : ""}${j.error ? ` (${j.error})` : ""}`),
    `usage: ${s.usageBeforeCU.toFixed(2)} -> ${s.usageAfterCU === null ? "?" : s.usageAfterCU.toFixed(2)} CU (actual ${s.actualCU === null ? "?" : s.actualCU.toFixed(2)}, estimate ${r.estimate.cu.toFixed(2)}, budget ${r.budgetCU.toFixed(2)})`,
    `stop verified: ${s.stop.verified ? "yes" : "NO (SESSION_LEAK)"}`,
    ...formatMaterialize(r.materialize),
  ];
  return lines.join("\n");
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
  if (r.gpuChoice) {
    const alts = r.gpuChoice.candidates.map((c) => `${c.gpu} ${c.cu.toFixed(2)} CU`).join(", ");
    lines.push(`gpu auto -> ${r.gpuChoice.chosen} (${alts})${r.gpuChoice.fallback ? `; fallback if unavailable: ${r.gpuChoice.fallback.gpu} ${r.gpuChoice.fallback.cu.toFixed(2)} CU` : ""}`);
  }
  lines.push(
    `estimate: ${e.cu.toFixed(2)} CU for ${r.jobsToGenerate} job(s) (${r.jobsCached} cached) on ${e.gpu} @ ${e.rateCuPerHour} CU/h (${e.rateSource}), margin ${e.margin}, budget ${r.budgetCU.toFixed(2)} CU`,
    `  fixed ${e.fixedSec.startup + e.fixedSec.firstLoad + e.fixedSec.teardown}s (startup ${e.fixedSec.startup} + first load ${e.fixedSec.firstLoad} + teardown ${e.fixedSec.teardown})`,
  );
  for (const j of e.jobs) lines.push(`  ${j.node}#${j.candidate} ${j.variant}: generate ${j.genSec}s (init ${j.initSec} + scale ${j.scale}) + download ${j.downloadSec}s`);
  lines.push(`  total ${e.totalSec}s`);
  if (r.gate.decision === "proceed") lines.push("gate: proceed");
  else {
    lines.push("gate: needs confirmation (exit 5)");
    for (const g of r.gate.reasons) lines.push(`  - ${g.message}\n    hint: ${g.hint}`);
  }
  return lines.join("\n");
}
