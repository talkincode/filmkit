// Guards AGENTS.md's rule: every `filmkit <subcommand>` and every `--flag`
// mentioned in skills/filmkit/SKILL.md must exist in the CLI, and every CLI
// subcommand must be documented in the skill.

import { readFileSync } from "node:fs";
import { COMMANDS, HELP } from "../src/cli.ts";

const skill = readFileSync(new URL("../skills/filmkit/SKILL.md", import.meta.url), "utf8");

// Only code spans / code blocks count as command mentions; prose like
// "filmkit validates" is not a command.
const code = [...skill.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]).join("\n");
const mentioned = new Set<string>();
for (const m of code.matchAll(/\bfilmkit\s+(?:--json\s+)?([a-z][a-z-]*)/g)) mentioned.add(m[1]!);

const cliCommands = new Set<string>(COMMANDS);
const helpFlags = new Set([...HELP.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
const skillFlags = new Set([...code.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]!));

const problems: string[] = [];
for (const c of mentioned) if (!cliCommands.has(c)) problems.push(`SKILL.md mentions "filmkit ${c}" but the CLI has no such command`);
for (const c of cliCommands) if (c !== "help" && !mentioned.has(c)) problems.push(`CLI command "${c}" is not documented in SKILL.md`);
for (const f of skillFlags) if (!helpFlags.has(f)) problems.push(`SKILL.md mentions flag "${f}" not present in --help`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`skill/CLI consistent: ${cliCommands.size} commands, ${skillFlags.size} flags`);
