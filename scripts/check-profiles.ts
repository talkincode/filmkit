// Static checks for the Profiles that ship with filmkit. They catch the class of
// mistake that only shows up when a tool actually runs otherwise:
//
//   * a param declared in paramsSchema that the invocation/cwd never uses
//     (scorekit's renderer/stems used to be declared and silently ignored);
//   * a placeholder the invocation uses but paramsSchema never declared;
//   * argv[0] differing from runtime.binary (doctor would probe the wrong thing);
//   * cross-field rules (`allOf`/`if`/`then`) that ajv cannot compile.
//
// Cheap by design: no tool is executed, no project is needed.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfileSource } from "../src/profile.ts";
import { parseYamlText } from "../src/yaml.ts";
import type { ProfileTask } from "../src/types.ts";

const dir = join(import.meta.dir, "..", "profiles");
const problems: string[] = [];
let tasks = 0;

const PLACEHOLDER = /\$\{([^}]*?)(\?)?\}/g;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
  const path = join(dir, file);
  let loaded;
  try {
    // loadProfileSource validates the Profile schema and compiles every paramsSchema.
    loaded = loadProfileSource(parseYamlText(readFileSync(path, "utf8"), path), file, false);
  } catch (err) {
    problems.push(`${file}: ${(err as Error).message}`);
    continue;
  }
  const profile = loaded.profile;
  const binary = profile.runtime.binary;

  for (const [name, task] of Object.entries(profile.tasks)) {
    tasks++;
    const where = `${file} ${name}`;
    const declared = Object.keys((task.paramsSchema as { properties?: Record<string, unknown> }).properties ?? {});
    // http specs are templates too: their JSON carries the same placeholders.
    const templates = [
      ...(task.invocation ?? []),
      ...(task.validate ?? []),
      ...(task.cwd ? [task.cwd] : []),
      ...(task.http ? [JSON.stringify(task.http)] : []),
    ];

    const used = new Set<string>();
    for (const element of templates) {
      for (const match of element.matchAll(PLACEHOLDER)) {
        const full = match[1]!;
        // `params.x`, and also `base64:params.x` / `mimeType:params.x`.
        for (const param of full.matchAll(/(?:^|:)params\.([A-Za-z0-9_]+)/g)) used.add(param[1]!);
      }
    }

    for (const param of declared) {
      if (!used.has(param)) {
        problems.push(`${where}: param "${param}" is declared but never used by invocation/validate/cwd`);
      }
    }
    for (const param of used) {
      if (!declared.includes(param)) {
        problems.push(`${where}: invocation uses params.${param}, which paramsSchema does not declare`);
      }
    }
    if (profile.runtime.type === "http" && !task.http) {
      problems.push(`${where}: runtime.type is http but the task has no http spec`);
    }
    if (profile.runtime.type !== "http" && task.http) {
      problems.push(`${where}: task declares an http spec but runtime.type is "${profile.runtime.type}"`);
    }
    if (binary && task.invocation && task.invocation[0] !== binary) {
      // doctor probes runtime.binary, so the command must be that same program
      // (or come after it, like `npx <tool>`).
      problems.push(`${where}: invocation starts with "${task.invocation[0]}" but runtime.binary is "${binary}"`);
    }
    const flags = (task.paramsSchema as { properties?: Record<string, { type?: string; items?: { enum?: string[] } }> }).properties?.flags;
    if (flags && flags.type === "array" && !flags.items?.enum) {
      problems.push(`${where}: a flags array must enumerate its items, or a typo reaches the tool`);
    }
  }
}

if (problems.length) {
  console.error("profile problems:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`profiles consistent: ${tasks} tasks across ${readdirSync(dir).filter((f) => f.endsWith(".yaml")).length} profiles`);
