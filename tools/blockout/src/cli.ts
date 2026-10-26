// blockout CLI: argv parsing, dispatch, --json errors, exit codes.
// main() returns the result instead of exiting so tests can run it in-process.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "./analysis.ts";
import { checkNoConflicts, renderBundle } from "./bundle.ts";
import { evaluate, frameAtTime } from "../runtime/blockout-core.js";
import { checkThreeProject, writeThreeProject } from "./engines/three.ts";
import { validateBlenderProject, writeBlenderProject } from "./engines/blender.ts";
import { BlockoutError, fail, formatDetail, invalid, io, missingDependency, type Detail } from "./errors.ts";
import { run } from "./exec.ts";
import { ffmpegVersion } from "./media.ts";
import { handoffGaps, loadScene, requireHandoff, sceneSchema, stillFrames } from "./scene.ts";
import { findBlender, findHyperframes } from "./tools.ts";
import { readVendor } from "./engines/three-project.ts";
import { HYPERFRAMES_PIN, TOOL_NAME, TOOL_VERSION } from "./version.ts";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const COMMANDS = ["validate", "eval", "check", "project", "render", "doctor", "schema", "help"] as const;

export const HELP = `blockout ${TOOL_VERSION} — an L0 white-model reference from one small explicit scene declaration, rendered by Blender or Three.js

A blockout is a MOTION / BLOCKING reference (where people and the camera go, what hides what).
It is not an identity reference and not a first frame. Nothing here calls a model or needs a credential.

usage:
  blockout validate <scene.json> [--handoff] [--engine blender|three] [--native] [--json]
        structure, references, ranges, camera sanity; geometry/contact warnings. --handoff also requires the complete
        upstream binding (composition, shot AND scene, environment variant, a variant on every subject and prop).
        --native additionally has the
        engine validate its own generated project (Blender opens the .blend; hyperframes check on the Three.js project)
  blockout eval <scene.json> (--time SECONDS | --frame N) [--json]
        the evaluated state at an absolute time: camera, every node pose, joint and hand positions
  blockout check <scene.json> [--strict] [--json]
        the declaration-derived facts that go into the manifest: ground contact, held props, occlusion, framing, penetrations
  blockout project <scene.json> --engine blender|three --out DIR [--force] [--json]
        write the engine's source project only (Three.js: a HyperFrames project; Blender: scripts + bake + scene.blend)
  blockout render <scene.json> --engine blender|three (--out DIR | --video FILE --manifest FILE) [--force] [--handoff]
                  [--seek-samples N] [--crf N] [--blender PATH] [--hyperframes CMD] [--json]
        render everything: reference.mp4, overview.png, keyframes/kf-<frame>.png, source.tar.gz, manifest.json
  blockout doctor [--engine blender|three] [--blender PATH] [--hyperframes CMD] [--json]
  blockout schema                      the scene declaration's JSON Schema
  blockout help

render writes into a staging directory and moves the bundle into DIR only when every artifact exists and verifies;
manifest.json lands last. Existing files are never overwritten (exit 1) unless --force, which replaces the bundle
transactionally. A failure leaves DIR exactly as it was.

options:
  --engine        blender (Workbench, native Python inside Blender) | three (HyperFrames + a vendored, pinned three.js)
  --seek-samples  random-access checks: frames rendered out of order and compared with the sequence (default 3). 0 skips it and
                  the manifest says so (verification.seek.status "skipped", identical null); --handoff refuses 0
  --blender       Blender executable (or BLOCKOUT_BLENDER; default search includes /Applications/Blender.app)
  --hyperframes   HyperFrames command (or BLOCKOUT_HYPERFRAMES, a node_modules/.bin on the project, or PATH; pinned ${HYPERFRAMES_PIN})
  --json          machine-readable output; errors as {"errors":[{code,message,field?,line?,column?,hint?}]} on stderr

exit codes: 0 ok, 1 io, 2 invalid input, 3 missing dependency, 4 tool failure`;

const OPTIONS = {
  engine: { type: "string" },
  out: { type: "string" },
  video: { type: "string" },
  manifest: { type: "string" },
  time: { type: "string" },
  frame: { type: "string" },
  "seek-samples": { type: "string" },
  crf: { type: "string" },
  blender: { type: "string" },
  hyperframes: { type: "string" },
  native: { type: "boolean", default: false },
  handoff: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

const out = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function integer(text: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) return fail(invalid(`${flag} must be an integer from ${min} to ${max}`, { field: flag }));
  return n;
}

function engineOf(text: string | undefined, required: boolean): "blender" | "three" | undefined {
  if (text === undefined) {
    if (required) fail(invalid("--engine is required: blender or three", { field: "--engine" }));
    return undefined;
  }
  if (text !== "blender" && text !== "three") return fail(invalid(`unknown engine "${text}"`, { field: "--engine", hint: "blender | three" }));
  return text;
}

function sceneArg(rest: string[], command: string) {
  if (rest.length !== 1) fail(invalid(`usage: blockout ${command} <scene.json> …`));
  return loadScene(rest[0]!);
}

/** Write a directory in staging and rename it into place; the destination is never half-written. */
async function atomicDir(dest: string, force: boolean, build: (dir: string) => Promise<void>): Promise<void> {
  const target = resolve(dest);
  if (existsSync(target) && !(readdirSync(target).length === 0)) {
    if (!force) fail(io(`${target} already exists and is not empty`, { hint: "pass --force to replace it, or choose another --out" }));
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.${basename(target)}.staging-`));
  try {
    await build(stage);
    if (existsSync(target)) {
      if (readdirSync(target).length === 0) rmdirSync(target);
      else rmSync(target, { recursive: true, force: true });
    }
    renameSync(stage, target);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<CliResult> {
  let json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    json = values.json;
    const [command, ...rest] = positionals;
    if (values.help || !command || command === "help") return { exitCode: 0, stdout: `${HELP}\n`, stderr: "" };
    if (command === "version") return { exitCode: 0, stdout: `${TOOL_NAME} ${TOOL_VERSION}\n`, stderr: "" };

    switch (command) {
      case "schema":
        return { exitCode: 0, stdout: out(sceneSchema()), stderr: "" };

      case "validate": {
        const engine = engineOf(values.engine, values.native);
        const loaded = sceneArg(rest, "validate");
        if (values.handoff) requireHandoff(loaded);
        const analysis = analyze(loaded.compiled);
        const result: Record<string, unknown> = {
          ok: true,
          scene: { id: loaded.scene.id, sha256: loaded.sha256 },
          timing: { ...loaded.scene.timing, durationSeconds: loaded.scene.timing.durationFrames / loaded.scene.timing.fps },
          subjects: (loaded.scene.subjects ?? []).map((s) => s.id),
          props: (loaded.scene.props ?? []).map((p) => p.id),
          stills: stillFrames(loaded.scene),
          handoff: { complete: handoffGaps(loaded.scene).length === 0, missing: handoffGaps(loaded.scene) },
          warnings: analysis.warnings,
        };
        if (values.native) {
          const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "blockout-validate-"));
          try {
            if (engine === "blender") result.native = { engine, ...(await validateBlenderProject(loaded, join(dir, "blender"), values.blender)) };
            else {
              writeThreeProject(loaded, join(dir, "three"));
              result.native = { engine, hyperframes: (await checkThreeProject(join(dir, "three"), values.hyperframes)).version };
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        const text = [
          `ok: ${loaded.scene.id} — ${loaded.scene.timing.durationFrames} frames @ ${loaded.scene.timing.fps} fps (${loaded.scene.timing.durationFrames / loaded.scene.timing.fps}s), ${loaded.compiled.width}x${loaded.compiled.height}`,
          ...analysis.warnings.map((w) => `warning: ${w}`),
          ...(result.native ? [`native (${engine}): ok`] : []),
        ].join("\n");
        return { exitCode: 0, stdout: json ? out(result) : `${text}\n`, stderr: "" };
      }

      case "eval": {
        const loaded = sceneArg(rest, "eval");
        const fps = loaded.scene.timing.fps;
        if ((values.time === undefined) === (values.frame === undefined)) fail(invalid("give exactly one of --time SECONDS or --frame N"));
        const t = values.time !== undefined ? Number(values.time) : (integer(values.frame, "--frame", 0, 100000)! / fps);
        if (!Number.isFinite(t)) fail(invalid("--time must be a number", { field: "--time" }));
        const e = evaluate(loaded.compiled, t);
        const points: Record<string, unknown> = {};
        for (const [id, fr] of Object.entries(e.frames)) {
          points[id] = { root: fr.root, joints: Object.fromEntries(Object.entries(fr.joints).map(([k, v]) => [k, v.pos])), points: Object.fromEntries(Object.entries(fr.points).map(([k, v]) => [k, v.pos])) };
        }
        return { exitCode: 0, stdout: out({ time: e.time, frame: frameAtTime(loaded.compiled, t), camera: e.camera, nodes: e.nodes, subjects: points }), stderr: "" };
      }

      case "check": {
        const loaded = sceneArg(rest, "check");
        const analysis = analyze(loaded.compiled);
        if (values.strict && analysis.warnings.length) {
          return { exitCode: 2, stdout: json ? out(analysis) : "", stderr: json ? `${JSON.stringify({ errors: analysis.warnings.map((w) => invalid(w)) })}\n` : `${analysis.warnings.map((w) => formatDetail(invalid(w))).join("\n")}\n` };
        }
        return { exitCode: 0, stdout: out(analysis), stderr: "" };
      }

      case "project": {
        const engine = engineOf(values.engine, true)!;
        if (!values.out) fail(invalid("usage: blockout project <scene.json> --engine blender|three --out DIR", { field: "--out" }));
        const loaded = sceneArg(rest, "project");
        await atomicDir(values.out, values.force, async (dir) => {
          if (engine === "three") writeThreeProject(loaded, dir);
          else await writeBlenderProject(loaded, dir, await findBlender(values.blender));
        });
        const files = readdirSync(resolve(values.out));
        return { exitCode: 0, stdout: json ? out({ engine, dir: resolve(values.out), files }) : `wrote ${engine} project: ${resolve(values.out)}\n`, stderr: "" };
      }

      case "render": {
        const engine = engineOf(values.engine, true)!;
        const loaded = sceneArg(rest, "render");
        if (values.handoff) requireHandoff(loaded);
        if (values.handoff && integer(values["seek-samples"], "--seek-samples", 0, 64) === 0) {
          fail(invalid("--handoff needs the random-seek check: --seek-samples 0 skips it", { field: "--seek-samples", hint: "a bundle handed upstream must say it was verified; drop --seek-samples 0, or drop --handoff for a local, unverified render" }));
        }
        let dir: string;
        let videoName = "reference.mp4";
        let manifestName = "manifest.json";
        if (values.out) {
          if (values.video || values.manifest) fail(invalid("--out and --video/--manifest are alternatives"));
          dir = values.out;
        } else if (values.video && values.manifest) {
          if (resolve(dirname(values.video)) !== resolve(dirname(values.manifest))) {
            fail(invalid("--video and --manifest must be in the same directory: the overview, keyframes and source archive land beside them", { field: "--manifest" }));
          }
          dir = dirname(values.video);
          videoName = basename(values.video);
          manifestName = basename(values.manifest);
          if (!videoName.endsWith(".mp4")) fail(invalid("--video must end in .mp4", { field: "--video" }));
        } else {
          return fail(invalid("give --out DIR, or --video FILE together with --manifest FILE"));
        }
        const r = await renderBundle(loaded, {
          engine,
          dir,
          videoName,
          manifestName,
          force: values.force,
          blender: values.blender,
          hyperframes: values.hyperframes,
          seekSamples: integer(values["seek-samples"], "--seek-samples", 0, 64) ?? 3,
          crf: integer(values.crf, "--crf", 0, 51),
        });
        const m = r.manifest;
        const text = [
          `rendered ${m.scene.id} with ${m.engine.name} ${m.engine.version}: ${m.render.durationFrames} frames @ ${m.render.fps} fps, ${m.render.width}x${m.render.height}`,
          ...m.artifacts.map((a) => `  ${a.path}  ${a.size} bytes  sha256 ${a.sha256.slice(0, 12)}…`),
          m.verification.seek.status === "verified"
            ? `  seek check: ${m.verification.seek.frames.join(", ")} identical=${m.verification.seek.identical}`
            : "  seek check: SKIPPED (--seek-samples 0): the bundle makes no claim about random seeking",
          ...m.analysis.warnings.map((w) => `warning: ${w}`),
          `manifest: ${r.manifestPath}`,
        ].join("\n");
        return { exitCode: 0, stdout: json ? out({ manifest: r.manifestPath, dir: resolve(dir), engine: m.engine, artifacts: m.artifacts.map((a) => ({ role: a.role, path: a.path, sha256: a.sha256, size: a.size })) }) : `${text}\n`, stderr: "" };
      }

      case "doctor": {
        const engine = engineOf(values.engine, false);
        const checks: { name: string; ok: boolean; detail: string; hint?: string }[] = [];
        const attempt = async (name: string, f: () => Promise<string>) => {
          try {
            checks.push({ name, ok: true, detail: await f() });
          } catch (err) {
            const d = err instanceof BlockoutError ? err.details[0]! : invalid((err as Error).message);
            checks.push({ name, ok: false, detail: d.message, ...(d.hint ? { hint: d.hint } : {}) });
          }
        };
        await attempt("ffmpeg", async () => `ffmpeg ${await ffmpegVersion()}`);
        await attempt("three.js (vendored)", async () => `three@${readVendor().pins.version}, sha256 verified`);
        if (engine !== "three") await attempt("blender", async () => `${(await findBlender(values.blender)).label} at ${(await findBlender(values.blender)).path}`);
        if (engine !== "blender") {
          await attempt("hyperframes", async () => {
            const h = await findHyperframes({ explicit: values.hyperframes });
            return `hyperframes ${h.version}${h.version === HYPERFRAMES_PIN ? "" : ` (tested with ${HYPERFRAMES_PIN})`}`;
          });
          await attempt("chrome (for hyperframes)", async () => {
            const h = await findHyperframes({ explicit: values.hyperframes });
            const r = await run([...h.argv, "doctor", "--json"], { timeout: 120_000 });
            const start = r.stdout.indexOf("{");
            const parsed = JSON.parse(balanced(r.stdout.slice(start))) as { checks: { name: string; ok: boolean; detail: string; hint?: string }[] };
            const chrome = parsed.checks.find((c) => c.name === "Chrome");
            if (!chrome?.ok) return fail(missingDependency(`Chrome is not available for hyperframes: ${chrome?.detail ?? "no Chrome check reported"}`, { hint: chrome?.hint ?? "run: hyperframes browser ensure" }));
            return chrome.detail;
          });
        }
        const ready = checks.every((c) => c.ok);
        const result = { ready, ...(engine ? { engine } : {}), checks };
        const text = checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}${c.hint ? `\n       ${c.hint}` : ""}`).join("\n");
        return { exitCode: ready ? 0 : 3, stdout: json ? out(result) : `${text}\n`, stderr: "" };
      }

      default:
        return fail(invalid(`unknown command "${command}"`, { hint: `commands: ${COMMANDS.join(", ")}` }));
    }
  } catch (err) {
    const details: Detail[] = err instanceof BlockoutError ? err.details : [invalid((err as Error).message ?? String(err), { hint: "see: blockout help" })];
    const exitCode = err instanceof BlockoutError ? err.exitCode : 2;
    return { exitCode, stdout: "", stderr: json ? `${JSON.stringify({ errors: details })}\n` : `${details.map(formatDetail).join("\n")}\n` };
  }
}

/** The first complete JSON value at the start of `text` (hyperframes doctor prints more after it). */
function balanced(text: string): string {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(0, i + 1);
  }
  return text;
}
