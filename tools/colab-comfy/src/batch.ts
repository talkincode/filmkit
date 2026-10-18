// `colab-comfy batch` (PLAN §5.4): plan -> jobs -> cache lookup -> estimate -> gate -> [lock -> session
// lifecycle -> ledger] -> materialize. `batchEstimate` is the free, offline half and never calls `colab`;
// `runBatch` adds steps 5-7 and 9 (the session lives in session.ts). Step 8 (materialize) is the M6 hook.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { cacheHit, jobCacheKey } from "./cache.ts";
import { sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT, type Detail } from "./errors.ts";
import { estimateCU, loadEstimates, type Breakdown, type EstimateJob } from "./estimate.ts";
import { decide, type GateResult } from "./gate.ts";
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

export interface EstimateReport {
  ok: boolean;
  mode: "estimate" | "batch";
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

interface Prepared {
  baseDir: string;
  selected: SelectedNode[];
  skipped: Skipped[];
  misses: EstimateJob[];
  cached: number;
  estimate: Breakdown;
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
    ok: gate.decision === "proceed",
    mode,
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
  return { baseDir, selected, skipped, misses, cached, estimate, gate, report };
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

export interface MaterializeSummary {
  status: "skipped" | "not-implemented";
  reason: string;
}

export interface BatchReport extends EstimateReport {
  session: SessionResult | null;
  materialize: MaterializeSummary;
}

/**
 * TODO(M6): step 8. For each selected node run `$FILMKIT run <id> --film F --json` (cache hits, 0 CU) and report
 * `needs-pick` for nodes with candidates > 1 and no `pick` (listing candidate cache paths) instead of running them.
 * Per node, so a partial session can still materialize the nodes whose clips all arrived.
 * Until M6 provides `colab-comfy materialize`, a default batch stops after the cache is filled.
 */
function materializeHook(opts: BatchOptions): MaterializeSummary {
  if (opts.noMaterialize) return { status: "skipped", reason: "--no-materialize" };
  return { status: "not-implemented", reason: "materialize lands in M6; clips are in .colab-comfy/cache, run `filmkit run <id>` after M6" };
}

function filmMeta(path: string): { name: string; sha256: string } {
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

/** Batch steps 1-7 and 9. Exit: 0 ok, 5 needs confirmation, otherwise the session's exit code (4 / 3 / 128+signal). */
export async function runBatch(opts: BatchOptions): Promise<{ report: BatchReport; exitCode: number; stderr: string }> {
  const env = opts.env ?? process.env;
  const p = await prepare(opts, "batch");
  const base = { ...p.report, mode: "batch" as const };
  if (p.misses.length === 0) {
    // Step 3: nothing to generate -> no session, no colab call, 0 CU.
    const report: BatchReport = { ...base, ok: true, session: null, materialize: materializeHook(opts) };
    return { report, exitCode: EXIT.ok, stderr: "" };
  }
  if (p.gate.decision !== "proceed") {
    const report: BatchReport = { ...base, ok: false, session: null, materialize: { status: "skipped", reason: "needs confirmation" } };
    return { report, exitCode: EXIT.needsConfirmation, stderr: "" };
  }

  const filmPath = resolve(opts.cwd, opts.film);
  const meta = filmMeta(filmPath);
  const name = opts.session ?? sessionName(meta.name);
  if (!name.startsWith("fk-") || !/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 40) {
    throw new ColabComfyError(EXIT.invalidInput, [
      { code: "invalid-input", message: `--session "${name}" must match fk-[a-z0-9-]*, at most 40 characters`, field: "session", hint: "reap only ever touches sessions whose name starts with fk-" },
    ]);
  }

  const release = acquireBatchLock(stateDir(p.baseDir)); // step 5
  let session: SessionResult;
  try {
    session = await runSession({
      baseDir: p.baseDir,
      name,
      film: opts.film,
      filmSha256: meta.sha256,
      gpu: opts.gpu,
      budgetCU: opts.budgetCU,
      estimateCU: p.estimate.cu,
      rateCuPerHour: p.estimate.rateCuPerHour,
      maxWallSec: opts.maxWallSec,
      nodes: p.selected,
      env,
      log: opts.log,
    }); // steps 6-7 (ledger is written by the session)
  } finally {
    release();
  }

  const stderr: string[] = [];
  if (session.leak) stderr.push(`SESSION_LEAK: ${session.session} may still be running; run \`colab-comfy reap\``);
  if (session.error) stderr.push(`error: ${session.error}`);
  for (const j of session.jobs) if (j.state !== "downloaded") stderr.push(`job ${j.node}#${j.candidate}: ${j.state}${j.error ? ` (${j.error})` : ""}`);
  for (const w of session.warnings) stderr.push(`warning: ${w}`);

  // Step 8 only runs for a session that generated everything it was asked to and was stopped cleanly.
  const materialize: MaterializeSummary =
    session.outcome === "ok" && !session.leak ? materializeHook(opts) : { status: "skipped", reason: `session outcome ${session.outcome}` };
  const report: BatchReport = { ...base, ok: session.exitCode === EXIT.ok, session, materialize };
  return { report, exitCode: session.exitCode, stderr: stderr.length ? stderr.join("\n") + "\n" : "" };
}

export function formatBatch(r: BatchReport): string {
  if (!r.session) {
    if (r.gate.decision !== "proceed") return formatEstimate(r);
    return formatEstimate(r) + `\nmaterialize: ${r.materialize.status} (${r.materialize.reason})`;
  }
  const s = r.session;
  const lines = [
    `session ${s.session}: ${s.outcome}${s.abortReason ? ` (${s.abortReason})` : ""}; ${s.jobsOk}/${s.jobsTotal} job(s) cached`,
    ...s.jobs.map((j) => `  ${j.node}#${j.candidate}: ${j.state}${j.cachePath ? ` -> ${j.cachePath}` : ""}${j.error ? ` (${j.error})` : ""}`),
    `usage: ${s.usageBeforeCU.toFixed(2)} -> ${s.usageAfterCU === null ? "?" : s.usageAfterCU.toFixed(2)} CU (actual ${s.actualCU === null ? "?" : s.actualCU.toFixed(2)}, estimate ${r.estimate.cu.toFixed(2)}, budget ${r.budgetCU.toFixed(2)})`,
    `stop verified: ${s.stop.verified ? "yes" : "NO (SESSION_LEAK)"}`,
    `materialize: ${r.materialize.status} (${r.materialize.reason})`,
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
