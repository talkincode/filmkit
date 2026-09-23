// Command-line entry. Argument parsing and output formatting only; every
// command's logic lives in its own module so it can be tested without a shell.

import { parseArgs } from "node:util";
import { build } from "./build/index.ts";
import { doctor, formatDoctor } from "./doctor.ts";
import { FilmkitError, formatDetail } from "./errors.ts";
import { loadFilm } from "./film.ts";
import { importHyperstory } from "./import.ts";
import { init } from "./init.ts";
import { formatPlan, makePlan } from "./plan.ts";
import { analyze, requireFilesPlaced } from "./project.ts";
import { runNode } from "./run.ts";
import { SCHEMAS } from "./schema.ts";
import { formatStoryboard, writeStoryboard } from "./storyboard.ts";
import { formatStatus, writeStatus } from "./status.ts";
import { VERSION } from "./version.ts";

export const COMMANDS = ["init", "schema", "validate", "plan", "storyboard", "run", "build", "status", "doctor", "import", "help"] as const;
export type Command = (typeof COMMANDS)[number];

export const HELP = `filmkit — agent-oriented video orchestration compiler

Usage: filmkit <command> [options]

Commands:
  init [dir]            Create a skeleton project (refuses a non-empty directory)
  schema [--profile|--lock|--cues]
                        Print the JSON Schema of filmkit.yaml (or Profile / Lock / Cues)
  validate              Schema, references, timeline and Profile paramsSchema checks
  plan                  Work order: nodes that are missing, stale or blocked, in order
  storyboard            Review sheet: build/storyboard.json + build/storyboard.html, proof every shot
  run <id> [--force]     Execute one node (cli or http); a ready http node needs --force to re-spend
  build [--draft] [--dry-run]
                        Normalize every produce, compose along the timeline, verify output
  status                Observe produces, write filmkit.lock.yaml, report readiness
  doctor                Check ffmpeg/ffprobe and every referenced Profile's requirements
  import hyperstory <schema.json> [--out filmkit.yaml] [--force]
                        Convert a Hyperstory Video Composition Schema into filmkit.yaml
  help                  Show this help

Options:
  --version, -V         Print the filmkit version and exit
  --film <path>         Orchestration file (default: ./filmkit.yaml)
  --json                Machine-readable output on stdout; errors as JSON on stderr
  --no-delegate         validate: skip Profile task \`validate\` commands
  -h, --help            Show help

Exit codes: 0 ok, 1 io, 2 invalid input, 3 missing dependency, 4 external tool failure
`;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function main(argv: string[]): CliResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        film: { type: "string", default: "./filmkit.yaml" },
        json: { type: "boolean", default: false },
        draft: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "no-delegate": { type: "boolean", default: false },
        profile: { type: "boolean", default: false },
        lock: { type: "boolean", default: false },
        cues: { type: "boolean", default: false },
        out: { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
  } catch (err) {
    return { exitCode: 2, stdout: "", stderr: `${(err as Error).message}\n\n${HELP}` };
  }
  const { values, positionals } = parsed;
  const command = (positionals[0] ?? "help") as string;
  const json = values.json;
  if (values.version) return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  if (values.help || command === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
  if (!(COMMANDS as readonly string[]).includes(command)) {
    return { exitCode: 2, stdout: "", stderr: `unknown command "${command}"\n\n${HELP}` };
  }

  try {
    const out = dispatch(command as Command, positionals.slice(1), values);
    return { exitCode: out.exitCode ?? 0, stdout: json ? JSON.stringify(out.json, null, 2) + "\n" : out.text + "\n", stderr: "" };
  } catch (err) {
    if (err instanceof FilmkitError) {
      const stderr = json ? JSON.stringify(err.toJSON(), null, 2) + "\n" : err.errors.map(formatDetail).join("\n") + "\n";
      return { exitCode: err.exitCode, stdout: "", stderr };
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return { exitCode: 1, stdout: "", stderr: json ? JSON.stringify({ errors: [{ code: "io", message }] }) + "\n" : `internal error: ${message}\n` };
  }
}

interface Values {
  film: string;
  json: boolean;
  draft: boolean;
  "dry-run": boolean;
  "no-delegate": boolean;
  profile: boolean;
  lock: boolean;
  cues: boolean;
  version: boolean;
  out?: string;
  force: boolean;
}

function dispatch(command: Command, rest: string[], v: Values): { json: unknown; text: string; exitCode?: number } {
  switch (command) {
    case "init": {
      const r = init(rest[0] ?? ".");
      return { json: r, text: `initialized ${r.dir}\n${r.files.map((f) => `  ${f}`).join("\n")}\nnext: filmkit validate && filmkit plan` };
    }
    case "schema": {
      const which = v.profile ? "profile" : v.lock ? "lock" : v.cues ? "cues" : "film";
      const s = SCHEMAS[which];
      return { json: s, text: JSON.stringify(s, null, 2) };
    }
    case "import": {
      const kind = rest[0];
      const source = rest[1];
      if (!kind || !source) throw new FilmkitError({ code: "invalid-input", message: "usage: filmkit import hyperstory <schema.json> [--out filmkit.yaml]" });
      if (kind !== "hyperstory") throw new FilmkitError({ code: "invalid-input", message: `unknown import kind "${kind}"`, hint: "supported: hyperstory" });
      const out = v.out ?? "./filmkit.yaml";
      const r = importHyperstory(source, out, { force: v.force });
      const lines = [
        `imported ${source} -> ${r.out} (${r.scenes} scenes, ${r.assets} assets)`,
        ...r.warnings.map((w) => `warning: ${w}`),
        ...(r.missingFiles.length ? [`files referenced but not in place yet (${r.missingFiles.length}): ${r.missingFiles.join(", ")}`, "next: filmkit plan"] : []),
      ];
      return { json: r, text: lines.join("\n") };
    }
    case "validate": {
      const a = analyze(v.film, { delegate: !v["no-delegate"] });
      if (a.missingFiles.length) throw new FilmkitError(requireFilesPlaced(a));
      const estimated = a.timeline.scenes.filter((p) => p.estimated).length;
      return {
        json: { ok: true, film: v.film, scenes: a.loaded.film.scenes.length, nodes: a.order.length, timeline: { total: a.timeline.total, estimatedScenes: estimated } },
        text: `ok: ${v.film} (${a.loaded.film.scenes.length} scenes, ${a.order.length} nodes, timeline ${a.timeline.total}s${estimated ? `, ${estimated} estimated` : ""})`,
      };
    }
    case "plan": {
      const plan = makePlan(analyze(v.film));
      return { json: plan, text: formatPlan(plan) };
    }
    case "storyboard": {
      const r = writeStoryboard(analyze(v.film, { delegate: false }));
      return { json: r.data, text: formatStoryboard(r.data) };
    }
    case "run": {
      const id = rest[0];
      if (!id) throw new FilmkitError({ code: "invalid-input", message: "run requires a node id: filmkit run <id>" });
      const r = runNode(analyze(v.film), id, { force: v.force });
      const how = r.argv ? r.argv.join(" ") : (r.requests ?? []).map((q) => `${q.method} ${q.url} → ${q.status}`).join(", ");
      return { json: r, text: `ran ${r.id}: ${how}\nproduced ${Object.values(r.produces).join(", ")}` };
    }
    case "build": {
      const r = build(analyze(v.film), { draft: v.draft, dryRun: v["dry-run"] });
      const lines = [
        r.dryRun ? `planned ${r.output} (${r.total}s) — nothing executed` : `built ${r.output} (${r.total}s${r.draft ? ", draft" : ""})`,
        `filtergraph: ${r.filtergraph}`,
        ...(r.subtitles ? [`subtitles: ${r.subtitles}`] : []),
        ...r.warnings.map((w) => `warning: ${w}`),
      ];
      return { json: r, text: lines.join("\n") };
    }
    case "status": {
      const r = writeStatus(analyze(v.film, { delegate: false }));
      return { json: r, text: formatStatus(r) };
    }
    case "doctor": {
      let loaded;
      try {
        loaded = loadFilm(v.film);
      } catch (err) {
        if (!(err instanceof FilmkitError) || err.errors.some((e) => e.code !== "io")) throw err;
        loaded = undefined; // no film here: report the environment only
      }
      const r = doctor(loaded, process.cwd());
      // The report is the useful part even when something is missing, so it goes
      // to stdout; the exit code carries the verdict (3 = missing dependency).
      return { json: r, text: formatDoctor(r), exitCode: r.ok ? 0 : 3 };
    }
    case "help":
      return { json: { help: HELP }, text: HELP };
  }
}
