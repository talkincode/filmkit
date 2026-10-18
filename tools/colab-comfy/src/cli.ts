// colab-comfy CLI: argv parsing, subcommand dispatch, --json errors, exit codes (PLAN §5.4).
// main() returns the result instead of exiting so tests can run it in-process.

import { parseArgs } from "node:util";
import { batchEstimate, formatEstimate } from "./batch.ts";
import { ColabComfyError, EXIT, invalid, type Detail } from "./errors.ts";
import { DEFAULT_BUDGET_CU, DEFAULT_GPU } from "./gate.ts";
import { jobFrames, normalizeJob, validateJob, variantKey } from "./job.ts";
import { loadTemplate } from "./workflow.ts";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const HELP = `colab-comfy — ComfyUI workflows on a Google Colab GPU, for filmkit

usage:
  colab-comfy validate <job flags> --out P --record R     offline checks; used by the Profile's validate
  colab-comfy batch --estimate [--film F] [--nodes a,b] [--gpu L4] [--rate CU_PER_H] [--budget CU] [--yes] [--filmkit "<cmd>"] [--json]
                                                          CU estimate + gate for every pending node; makes no colab call
  colab-comfy materialize <job flags> --out P --record R  (not implemented yet)
  colab-comfy batch [--yes ...]                           (session execution: not implemented yet)

job flags: --node= --template= --prompt= --ref= [--ref2=] [--ref3=] --seed= --duration= --resolution=
           [--sparsity=] [--candidates=] [--pick=]

common: --json  machine-readable output; errors as {"errors":[{code,message,field?,hint?}]} on stderr

env:  COLAB_COMFY_BUDGET_CU   hard cap in CU (default ${DEFAULT_BUDGET_CU})
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
  budget: { type: "string" },
  gpu: { type: "string", default: DEFAULT_GPU },
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
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): Promise<CliResult> {
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
      case "materialize":
        throw notImplemented("materialize");
      default:
        return { exitCode: EXIT.invalidInput, stdout: "", stderr: `unknown command "${command}"\n\n${HELP}` };
    }
    return { exitCode: out.exitCode ?? EXIT.ok, stdout: v.json ? JSON.stringify(out.json, null, 2) + "\n" : out.text + "\n", stderr: "" };
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

function notImplemented(what: string): ColabComfyError {
  return new ColabComfyError(EXIT.io, [{ code: "not-implemented", message: `${what} is not implemented in this build yet`, hint: "only validate and batch --estimate exist so far" }]);
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

async function batchCommand(v: Values, env: Record<string, string | undefined>, cwd: string): Promise<Out> {
  if (!v.estimate) throw notImplemented("batch (session execution)");
  const budget = parseNumberFlag(v.budget ?? env.COLAB_COMFY_BUDGET_CU, "budget", DEFAULT_BUDGET_CU)!;
  const { report, exitCode } = await batchEstimate({
    cwd,
    film: v.film,
    nodes: v.nodes ? v.nodes.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    filmkit: v.filmkit ?? env.COLAB_COMFY_FILMKIT ?? "filmkit",
    gpu: v.gpu,
    rate: parseNumberFlag(v.rate, "rate"),
    budgetCU: budget,
    yes: v.yes,
  });
  return { json: report, text: formatEstimate(report), exitCode };
}
