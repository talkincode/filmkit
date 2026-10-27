// vflow-pull CLI: argv parsing, dispatch, --json errors, exit codes.
// main() returns the result instead of exiting so tests can run it in-process.

import { parseArgs } from "node:util";
import { type Client, createClient, ENV_CLIENT_ID, ENV_CLIENT_SECRET, normalizeBase, resolveCredentials } from "./client.ts";
import { type Detail, fail, invalid, PullError } from "./errors.ts";
import { convertFile, fetchFromFile, pull, writeNewFile, type Report } from "./pull.ts";
import { packageMotion } from "./motion-package.ts";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const COMMANDS = ["pull", "convert", "fetch", "package-motion", "help"] as const;

export const HELP = `vflow-pull — read a vflow composition into a filmkit project (read-only: nothing is ever written back to vflow)

usage:
  vflow-pull pull --project P --composition C [--revision N] [--base URL] [--out filmkit.yaml] [--force] [--json]
        export the composition, fetch the reference images and shot materials it uses (sha256-verified),
        and write a new filmkit.yaml plus vflow/<composition>@<revision>.bundle.json
  vflow-pull convert <bundle.json|yaml> [--out filmkit.yaml] [--force] [--json]
        offline: turn an exported bundle (e.g. from the vflow MCP composition_export) into a filmkit.yaml;
        lists the files still missing
  vflow-pull fetch <bundle.json|yaml> [--base URL] [--dir .] [--force] [--json]
        bytes only: download what the bundle's film references into --dir
  vflow-pull package-motion <manifest.json> --binding <vflow-bindings.json> [--out package.json] [--force] [--json]
        offline: require a complete rendered handoff, map upstream pins/roles and verify explicit assertions; emit an unreviewed
        motion_reference candidate plus upload list (no network write, no approval, no guessed bindings)
  vflow-pull help

what is taken: shot description and video prompt, shot material images and reference videos,
pinned character/prop reference images (approved entries of the resolved variant), selected.video when present.
Reference videos remain input assets, never final clips; legacy references without approval are marked unverified. Everything else is listed as ignored.
The film is a new file: existing ones are refused unless --force. impl/params are never guessed.

options: --mode production|assemble  pull/convert/fetch only (default: production).
         production keeps the existing reference-oriented import and min durations.
         assemble requires selected videos and exact durations; imports selected audio (replaces clip sound)
         and global audio tracks, with explicit local ffmpeg source-crop nodes. No tools run during pull.
         Use the SAME mode for convert and fetch. Neither mode is incremental sync.
         --base URL   the vflow origin (or VFLOW_BASE_URL); https only, plain http only for localhost
         --json       machine-readable output; errors as {"errors":[{code,message,field?,hint?}]} on stderr

credentials (vflow sits behind Cloudflare Access), first that applies:
             a service token in ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} (environment, then the filmkit vault), or
             your own login via cloudflared: run \`cloudflared access login <vflow url>\` once.
             They go in request headers only and are never printed or stored.

exit codes: 0 ok, 1 io, 2 invalid input, 3 missing dependency (credentials), 4 tool failure`;

const OPTIONS = {
  binding: { type: "string" },
  mode: { type: "string" },
  project: { type: "string" },
  composition: { type: "string" },
  revision: { type: "string" },
  base: { type: "string" },
  out: { type: "string" },
  dir: { type: "string" },
  force: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

function formatReport(r: Report): string {
  const lines: string[] = [];
  if (r.out) lines.push(`wrote ${r.out} (${r.scenes} scenes, ${r.assets} assets)`);
  else lines.push(`${r.scenes} scenes, ${r.assets} assets`);
  if (r.downloaded || r.present) lines.push(`files: ${r.downloaded} downloaded, ${r.present} already in place`);
  if (r.bundle) lines.push(`bundle record: ${r.bundle}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.ignored.length) lines.push(`not imported: ${r.ignored.join(", ")}`);
  if (r.missingFiles.length) lines.push(`files referenced but not in place yet (${r.missingFiles.length}): ${r.missingFiles.join(", ")}`, "next: vflow-pull fetch <bundle> (bytes), then validate and plan the film");
  else if (r.out) lines.push("next: validate and plan the film");
  return lines.join("\n");
}

function formatErrors(details: Detail[]): string {
  return details
    .map((d) => {
      const head = d.field ? `[${d.code}] ${d.field}: ${d.message}` : `[${d.code}] ${d.message}`;
      return d.hint ? `${head}\n  hint: ${d.hint}` : head;
    })
    .join("\n");
}

function clientFor(values: { base?: string }): Client {
  const base = values.base ?? process.env.VFLOW_BASE_URL;
  if (!base) fail(invalid("no vflow origin: pass --base URL or set VFLOW_BASE_URL"));
  const origin = normalizeBase(base); // refuses cleartext before any credential is looked up
  return createClient(origin, resolveCredentials(origin));
}

export async function main(argv: string[]): Promise<CliResult> {
  let json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    json = values.json;
    const [command, ...rest] = positionals;
    if (values.help || !command || command === "help") return { exitCode: 0, stdout: `${HELP}\n`, stderr: "" };

    if (values.mode !== undefined && (!["production", "assemble"].includes(values.mode) || !["pull", "convert", "fetch"].includes(command)))
      fail(invalid("--mode must be production or assemble, for pull/convert/fetch only", { field: "--mode" }));
    const mode = (values.mode ?? "production") as "production" | "assemble";
    let result: Report;
    switch (command) {
      case "package-motion": {
        if (!rest[0] || !values.binding) fail(invalid("usage: vflow-pull package-motion <manifest.json> --binding <vflow-bindings.json>"));
        const packaged = await packageMotion(rest[0], values.binding);
        const output = `${JSON.stringify(packaged, null, 2)}\n`;
        if (values.out) writeNewFile(values.out, output, values.force);
        return { exitCode: 0, stdout: output, stderr: "" };
      }
      case "convert": {
        if (!rest[0]) fail(invalid("usage: vflow-pull convert <bundle.json|yaml> [--out filmkit.yaml]"));
        result = convertFile({ bundlePath: rest[0], out: values.out ?? "./filmkit.yaml", force: values.force, mode });
        break;
      }
      case "fetch": {
        if (!rest[0]) fail(invalid("usage: vflow-pull fetch <bundle.json|yaml> [--base URL] [--dir .]"));
        result = await fetchFromFile({ bundlePath: rest[0], client: clientFor(values), dir: values.dir ?? ".", force: values.force, mode });
        break;
      }
      case "pull": {
        if (!values.project || !values.composition) fail(invalid("usage: vflow-pull pull --project P --composition C [--revision N] [--base URL]"));
        const revision = values.revision === undefined ? undefined : Number(values.revision);
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) fail(invalid("--revision must be a positive integer", { field: "--revision" }));
        result = await pull({ client: clientFor(values), project: values.project, composition: values.composition, revision, out: values.out ?? "./filmkit.yaml", force: values.force, mode });
        break;
      }
      default:
        return fail(invalid(`unknown command "${command}"`, { hint: `commands: ${COMMANDS.join(", ")}` }));
    }
    return { exitCode: 0, stdout: json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result)}\n`, stderr: "" };
  } catch (err) {
    const details: Detail[] =
      err instanceof PullError ? err.details : [invalid((err as Error).message ?? String(err), { hint: "see: vflow-pull help" })];
    const exitCode = err instanceof PullError ? err.exitCode : 2;
    return { exitCode, stdout: "", stderr: json ? `${JSON.stringify({ errors: details })}\n` : `${formatErrors(details)}\n` };
  }
}
