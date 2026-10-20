// Guards AGENTS.md's rule: every `filmkit <subcommand>` and every `--flag`
// mentioned in the filmkit skill (skills/filmkit/SKILL.md and its
// references/*.md) must exist in the CLI, and every CLI subcommand must be
// documented in SKILL.md itself.

import { readdirSync, readFileSync } from "node:fs";
import { COMMANDS, HELP } from "../src/cli.ts";

const skillDir = new URL("../skills/filmkit/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8");
// Reference files the skill sends the agent to are part of the skill: a wrong
// command there misleads exactly as much as one in SKILL.md.
const references = readdirSync(new URL("references/", skillDir))
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ file: `references/${f}`, text: readFileSync(new URL(`references/${f}`, skillDir), "utf8") }));
const docs = [{ file: "SKILL.md", text: skill }, ...references];

// Only code spans / code blocks count as command mentions; prose like
// "filmkit validates" is not a command. Comments inside those blocks are prose
// too (a YAML `# filmkit checks …` note is not a command), so they are dropped:
// whole-line comments and trailing ` # …` notes.
function codeOf(text: string): string {
  return [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)]
    .map((m) => m[0])
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}
const commandsIn = (code: string): Set<string> => new Set([...code.matchAll(/\bfilmkit\s+(?:--json\s+)?([a-z][a-z-]*)/g)].map((m) => m[1]!));

const cliCommands = new Set<string>(COMMANDS);
const helpFlags = new Set([...HELP.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));

const problems: string[] = [];
let flagCount = 0;
for (const { file, text } of docs) {
  const code = codeOf(text);
  for (const c of commandsIn(code)) if (!cliCommands.has(c)) problems.push(`${file} mentions "filmkit ${c}" but the CLI has no such command`);
  // Only flags on lines that talk about filmkit: the skill also quotes other
  // tools' flags (hyperframes --fps, imagine --seed), and those are not ours.
  const filmkitLines = code
    .split("\n")
    .filter((line) => /\bfilmkit\b/.test(line))
    .join("\n");
  const flags = new Set([...filmkitLines.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]!));
  flagCount += flags.size;
  for (const f of flags) if (!helpFlags.has(f)) problems.push(`${file} mentions flag "${f}" not present in --help`);
}
const documented = commandsIn(codeOf(skill));
for (const c of cliCommands) if (c !== "help" && !documented.has(c)) problems.push(`CLI command "${c}" is not documented in SKILL.md`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`skill/CLI consistent: ${cliCommands.size} commands, ${flagCount} flag mentions across ${docs.length} files`);
