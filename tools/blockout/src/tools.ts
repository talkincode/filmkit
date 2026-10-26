// Finding the external programs blockout drives. Nothing is downloaded or installed
// behind the user's back: a missing tool is a missing-dependency error that says
// where it looked and what to do.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail, missingDependency } from "./errors.ts";
import { run, RunError } from "./exec.ts";
import { HYPERFRAMES_PIN } from "./version.ts";

export interface Blender {
  path: string;
  /** "5.2.3" */
  version: string;
  /** "5.2.3 LTS (e13b728c6880)" */
  label: string;
}

const BLENDER_CANDIDATES = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/opt/homebrew/bin/blender",
  "/usr/local/bin/blender",
  "/usr/bin/blender",
  "/snap/bin/blender",
];

/**
 * Where Blender is looked for. A path the user named (--blender, or BLOCKOUT_BLENDER) is the only
 * candidate: if it does not work that is an error, never a quiet switch to some other Blender.
 */
export function blenderSearch(explicit?: string): string[] {
  const named = explicit ?? process.env.BLOCKOUT_BLENDER;
  if (named) return [named];
  const list = [process.env.BLENDER, Bun.which("blender") ?? undefined, ...BLENDER_CANDIDATES];
  return [...new Set(list.filter((p): p is string => !!p))];
}

export async function findBlender(explicit?: string): Promise<Blender> {
  const tried = blenderSearch(explicit);
  for (const path of tried) {
    if (!existsSync(path)) continue;
    try {
      const r = await run([path, "--version"], { timeout: 60_000 });
      const v = /^Blender (\d+\.\d+\.\d+)(?: (\w+))?/m.exec(r.stdout);
      if (r.status === 0 && v) {
        const hash = /build hash: (\w+)/.exec(r.stdout)?.[1];
        return { path, version: v[1]!, label: `${v[1]}${v[2] ? ` ${v[2]}` : ""}${hash ? ` (${hash})` : ""}` };
      }
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
    }
  }
  return fail(
    missingDependency("Blender was not found", {
      hint: `looked at: ${tried.join(", ")}. Install Blender, or set BLOCKOUT_BLENDER / pass --blender <path to the Blender executable>`,
    }),
  );
}

export interface Hyperframes {
  /** argv prefix: ["/path/to/hyperframes"] */
  argv: string[];
  version: string;
}

/**
 * A command the user named (--hyperframes, or BLOCKOUT_HYPERFRAMES) is the only candidate. Otherwise: the
 * project's own node_modules, this tool's node_modules, then PATH. Never `npx` without --no-install.
 */
export async function findHyperframes(opts: { explicit?: string; projectDir?: string }): Promise<Hyperframes> {
  const candidates: string[][] = [];
  const named = opts.explicit ?? process.env.BLOCKOUT_HYPERFRAMES;
  if (named) candidates.push(named.split(/\s+/));
  else {
    if (opts.projectDir) candidates.push([join(opts.projectDir, "node_modules", ".bin", "hyperframes")]);
    candidates.push([join(import.meta.dir, "..", "node_modules", ".bin", "hyperframes")]);
    const onPath = Bun.which("hyperframes");
    if (onPath) candidates.push([onPath]);
  }
  const tried: string[] = [];
  for (const argv of candidates) {
    tried.push(argv.join(" "));
    if (!argv[0] || (argv[0].includes("/") && !existsSync(argv[0]))) continue;
    try {
      const r = await run([...argv, "--version"], { timeout: 120_000, cwd: opts.projectDir });
      const v = /(\d+\.\d+\.\d+)/.exec(r.stdout);
      if (r.status === 0 && v) return { argv, version: v[1]! };
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
    }
  }
  return fail(
    missingDependency("the HyperFrames CLI was not found", {
      hint: `looked at: ${tried.join(", ")}. Install it somewhere stable (npm install --prefix ~/.local/share/blockout hyperframes@${HYPERFRAMES_PIN}) and set BLOCKOUT_HYPERFRAMES=<that>/node_modules/.bin/hyperframes, or pass --hyperframes <command>`,
    }),
  );
}
