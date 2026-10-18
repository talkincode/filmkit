// colab-comfy CLI: argv parsing, subcommand dispatch, --json errors, exit codes (PLAN §5.4).
// main() returns the result instead of exiting so tests can run it in-process.

import { parseArgs } from "node:util";
import { batchEstimate, formatBatch, formatEstimate, runBatch } from "./batch.ts";
import { Colab } from "./colab.ts";
import { ColabComfyError, EXIT, invalid, type Detail } from "./errors.ts";
import { DEFAULT_BUDGET_CU, GPU_AUTO } from "./gate.ts";
import { runGuard } from "./guard.ts";
import { jobFrames, normalizeJob, validateJob, variantKey } from "./job.ts";
import { formatCacheList, formatPrune, listCache, pruneCache } from "./cache-tools.ts";
import { doctor, formatDoctor } from "./doctor.ts";
import { materialize } from "./materialize.ts";
import { stateDir } from "./ledger.ts";
import { formatReap, reap } from "./reap.ts";
import { backoffFromEnv } from "./teardown.ts";
import { loadTemplate } from "./workflow.ts";
import { dirname, join, resolve } from "node:path";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const HELP = `colab-comfy — ComfyUI workflows on a Google Colab GPU, for filmkit

usage:
  colab-comfy validate <job flags> --out P --record R     offline checks; used by the Profile's validate
  colab-comfy batch --estimate [--film F] [--nodes a,b] [--gpu auto|L4|A100] [--rate CU_PER_H] [--budget CU] [--yes] [--filmkit "<cmd>"] [--json]
                                                          CU estimate + gate for every pending node; makes no colab call
  colab-comfy batch [--film F] [--nodes a,b] [--yes] [--budget CU] [--gpu auto|L4|A100] [--rate CU_PER_H] [--max-wall SEC]
                    [--session fk-NAME] [--filmkit "<cmd>"] [--no-materialize] [--json]
                                                          one Colab session for every pending node; always stops and verifies it
  colab-comfy reap [--film F] [--dry-run] [--json]        stop OUR leaked sessions (fk-* recorded in .colab-comfy/active.json); never others
  colab-comfy guard --session NAME --parent-pid PID --deadline EPOCH --state DIR
                                                          internal: detached watchdog started by batch
  colab-comfy cache ls [--film F] [--json]                list cached clips (node, candidate, seed, size, referenced-by)
  colab-comfy cache prune --keep-referenced [--film F] [--dry-run] [--json]
                                                          delete cached clips no run record in the lock names as winner
  colab-comfy cache prune --yes [--film F] [--dry-run]    delete EVERY cached clip (each cost CU to make; refused without --yes)
  colab-comfy doctor [--json]                             { ready, checks[] }: colab on PATH, version, auth probe, leftover fk-* sessions, templates
  colab-comfy materialize <job flags> --out P --record R [--film F]
                                                          copy the cached clip to --out and write the run record (--record); used by the
                                                          Profile's invocation (\`filmkit run\`). Cache miss: exit 5, or with COLAB_COMFY_YES=1 a
                                                          batch of one under the same budget gate. candidates > 1 without --pick: exit 2.

job flags: --node= --template= --prompt= --ref= [--ref2=] [--ref3=] --seed= --duration= --resolution=
           [--sparsity=] [--candidates=] [--pick=]

common: --json  machine-readable output; errors as {"errors":[{code,message,field?,hint?}]} on stderr

env:  COLAB_COMFY_YES=1         authorize a spend from \`filmkit run\` (cache miss; batch of one)
      COLAB_COMFY_BUDGET_CU   hard cap in CU (default ${DEFAULT_BUDGET_CU})
      COLAB_COMFY_AUTH        passed as \`colab --auth <v>\` (default adc); COLAB_CLI_CONFIG as \`--config\`
      COLAB_COMFY_POLL_SEC    seconds between polls (default 20); COLAB_COMFY_BACKOFF_MS stop/verify backoff
      COLAB_COMFY_QUIET=1     no progress lines on stderr
      COLAB_COMFY_FILMKIT     how to run filmkit, e.g. "bun /path/bin/filmkit.ts" (default: filmkit)

exit codes: 0 ok, 1 io, 2 invalid input, 3 missing dependency, 4 tool failure, 5 needs confirmation
`;

const OPTIONS = {
  node: { type: "string" },
  template: { type: "string" },
  prompt: { type: "string" },
  ref: { type: "string" },
  ref2: { type: "string" },
  ref3: { type: "string" },
  seed: { type: "string" },
  duration: { type: "string" },
  resolution: { type: "string" },
  sparsity: { type: "string" },
  candidates: { type: "string" },
  pick: { type: "string" },
  out: { type: "string" },
  record: { type: "string" },
  film: { type: "string", default: "./filmkit.yaml" },
  nodes: { type: "string" },
  estimate: { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  "keep-referenced": { type: "boolean", default: false },
  budget: { type: "string" },
  session: { type: "string" },
  "max-wall": { type: "string" },
  "no-materialize": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  "parent-pid": { type: "string" },
  deadline: { type: "string" },
  state: { type: "string" },
  gpu: { type: "string", default: GPU_AUTO },
  rate: { type: "string" },
  filmkit: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Values = {
  [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string | undefined;
} & { film: string; gpu: string };

interface Out {
  json: unknown;
  text: string;
  exitCode?: number;
  /** Human-readable diagnostics for stderr (kept out of --json stdout). */
  stderr?: string;
}

/** `env` entries override the process environment (they do not replace it: children still need PATH). */
export async function main(argv: string[], envOverrides: Record<string, string | undefined> = {}, cwd: string = process.cwd()): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    return { exitCode: EXIT.invalidInput, stdout: "", stderr: `${(err as Error).message}\n\n${HELP}` };
  }
  const v = parsed.values as unknown as Values;
  const command = parsed.positionals[0] ?? "help";
  if (v.help || command === "help") return { exitCode: EXIT.ok, stdout: HELP, stderr: "" };

  try {
    let out: Out;
    switch (command) {
      case "validate":
        out = validateCommand(v, cwd);
        break;
      case "batch":
        out = await batchCommand(v, env, cwd);
        break;
      case "reap":
        out = await reapCommand(v, env, cwd);
        break;
      case "guard":
        out = await guardCommand(v, env);
        break;
      case "cache":
        out = cacheCommand(v, parsed.positionals[1], cwd);
        break;
      case "doctor": {
        const report = await doctor(env);
        out = { json: report, text: formatDoctor(report), exitCode: report.ready ? EXIT.ok : EXIT.missingDependency };
        break;
      }
      case "materialize":
        out = await materializeCommand(v, env, cwd);
        break;
      default:
        return { exitCode: EXIT.invalidInput, stdout: "", stderr: `unknown command "${command}"\n\n${HELP}` };
    }
    return { exitCode: out.exitCode ?? EXIT.ok, stdout: v.json ? JSON.stringify(out.json, null, 2) + "\n" : out.text + "\n", stderr: out.stderr ?? "" };
  } catch (err) {
    if (err instanceof ColabComfyError) {
      const stderr = v.json ? JSON.stringify({ errors: err.details }, null, 2) + "\n" : err.details.map(formatDetail).join("\n") + "\n";
      return { exitCode: err.exitCode, stdout: "", stderr };
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return { exitCode: EXIT.io, stdout: "", stderr: v.json ? JSON.stringify({ errors: [{ code: "io", message }] }) + "\n" : `internal error: ${message}\n` };
  }
}

function formatDetail(d: Detail): string {
  return `error: ${d.field ? `${d.field}: ` : ""}${d.message}${d.hint ? `\n  hint: ${d.hint}` : ""}`;
}

function validateCommand(v: Values, cwd: string): Out {
  const missing: Detail[] = [];
  if (v.out === undefined) missing.push(invalid("--out is required", "out"));
  if (v.record === undefined) missing.push(invalid("--record is required", "record"));
  const job = (() => {
    try {
      return normalizeJob({ ...v });
    } catch (err) {
      if (err instanceof ColabComfyError) throw new ColabComfyError(err.exitCode, [...err.details, ...missing]);
      throw err;
    }
  })();
  const tpl = loadTemplate(job.template);
  // Film-relative paths: filmkit runs this with cwd = film dir.
  const problems = [...missing, ...validateJob(job, { baseDir: cwd, tpl, out: v.out, record: v.record })];
  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  const frames = jobFrames(job, tpl);
  const summary = { ok: true, node: job.node ?? null, template: job.template, variant: variantKey(job), frames, width: job.width, height: job.height, refs: job.refs.length, candidates: job.candidates };
  return {
    json: summary,
    text: `ok: ${job.node ?? "job"} ${summary.variant} ${job.width}x${job.height} ${frames}f, ${job.refs.length} ref(s), ${job.candidates} candidate(s)`,
  };
}

function parseNumberFlag(raw: string | undefined, name: string, fallback?: number): number | undefined {
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw) || !(Number(raw) > 0)) {
    throw new ColabComfyError(EXIT.invalidInput, [invalid(`--${name} must be a positive number, got "${raw}"`, name)]);
  }
  return Number(raw);
}

const PLAIN_INT = /^\d+$/;

function parseWallSec(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!PLAIN_INT.test(raw) || Number(raw) <= 0) throw new ColabComfyError(EXIT.invalidInput, [invalid(`--max-wall must be a positive integer (seconds), got "${raw}"`, "max-wall")]);
  return Number(raw);
}

function progressLogger(env: Record<string, string | undefined>): (line: string) => void {
  return env.COLAB_COMFY_QUIET ? () => {} : (line) => void process.stderr.write(`[colab-comfy] ${line}\n`);
}

async function batchCommand(v: Values, env: Record<string, string | undefined>, cwd: string): Promise<Out> {
  const budget = parseNumberFlag(v.budget ?? env.COLAB_COMFY_BUDGET_CU, "budget", DEFAULT_BUDGET_CU)!;
  const common = {
    cwd,
    film: v.film,
    nodes: v.nodes ? v.nodes.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    filmkit: v.filmkit ?? env.COLAB_COMFY_FILMKIT ?? "filmkit",
    gpu: v.gpu.toLowerCase() === GPU_AUTO ? GPU_AUTO : v.gpu.toUpperCase(),
    rate: parseNumberFlag(v.rate, "rate"),
    budgetCU: budget,
    yes: v.yes,
    env,
  };
  if (v.estimate) {
    const { report, exitCode } = await batchEstimate(common);
    return { json: report, text: formatEstimate(report), exitCode };
  }
  const { report, exitCode, stderr } = await runBatch({
    ...common,
    session: v.session,
    maxWallSec: parseWallSec(v["max-wall"]),
    noMaterialize: v["no-materialize"],
    log: progressLogger(env),
  });
  return { json: report, text: formatBatch(report), exitCode, stderr };
}

async function materializeCommand(v: Values, env: Record<string, string | undefined>, cwd: string): Promise<Out> {
  const budget = parseNumberFlag(v.budget ?? env.COLAB_COMFY_BUDGET_CU, "budget", DEFAULT_BUDGET_CU)!;
  const { report, stderr } = await materialize({ flags: { ...v }, out: v.out, record: v.record, film: v.film, cwd, budgetCU: budget, env, log: progressLogger(env) });
  return {
    json: report,
    text: `materialized ${report.node ?? "job"}: candidate ${report.winner.index} (seed ${report.winner.seed}) -> ${report.out}, record ${report.record}${report.spent ? ` (spent: session ${report.session})` : ""}`,
    stderr,
  };
}

function cacheCommand(v: Values, sub: string | undefined, cwd: string): Out {
  const baseDir = dirname(resolve(cwd, v.film));
  const lockPath = join(baseDir, "filmkit.lock.yaml");
  if (sub === "ls") {
    const entries = listCache(baseDir, lockPath);
    return { json: { entries }, text: formatCacheList(entries) };
  }
  if (sub === "prune") {
    const report = pruneCache({ baseDir, lockPath, keepReferenced: v["keep-referenced"], yes: v.yes, dryRun: v["dry-run"] });
    return { json: report, text: formatPrune(report) };
  }
  throw new ColabComfyError(EXIT.invalidInput, [invalid(`cache needs a subcommand: ls | prune (got ${sub === undefined ? "none" : `"${sub}"`})`, "cache")]);
}

async function reapCommand(v: Values, env: Record<string, string | undefined>, cwd: string): Promise<Out> {
  const baseDir = dirname(resolve(cwd, v.film));
  const report = await reap({
    stateDir: stateDir(baseDir),
    colab: new Colab({ env }),
    backoffMs: backoffFromEnv(env),
    dryRun: v["dry-run"],
    log: progressLogger(env),
  });
  return { json: report, text: formatReap(report), exitCode: report.ok ? EXIT.ok : EXIT.toolFailure };
}

async function guardCommand(v: Values, env: Record<string, string | undefined>): Promise<Out> {
  const problems: Detail[] = [];
  const need = (k: "session" | "parent-pid" | "deadline" | "state") => {
    if (v[k] === undefined) problems.push(invalid(`--${k} is required`, k));
  };
  need("session");
  need("parent-pid");
  need("deadline");
  need("state");
  const parent = Number(v["parent-pid"]);
  const deadline = Number(v.deadline);
  if (v["parent-pid"] !== undefined && !(Number.isInteger(parent) && parent > 0)) problems.push(invalid("--parent-pid must be a positive integer", "parent-pid"));
  if (v.deadline !== undefined && !Number.isFinite(deadline)) problems.push(invalid("--deadline must be epoch seconds", "deadline"));
  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  const r = await runGuard({ session: v.session!, parentPid: parent, deadline, stateDir: v.state!, env, log: progressLogger(env) });
  return { json: r, text: `guard exit: ${r.reason}`, exitCode: r.exitCode };
}
