// `filmkit run <id>`: execute one cli node's invocation template and record
// the result (spec §6). Anything not `cli` + `invocation` is the agent's job.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FilmkitError, invalid, type ErrorDetail } from "./errors.ts";
import { classifyExit, exec, execFailure } from "./exec.ts";
import type { Analysis } from "./project.ts";
import { observeNode, toLockNode } from "./state.ts";
import { taskCommand } from "./template.ts";
import { emptyLock, writeLock } from "./lock.ts";
import type { ProduceType } from "./types.ts";

export interface RunResult {
  id: string;
  argv: string[];
  produces: Record<string, string>;
}

export function runNode(a: Analysis, id: string): RunResult {
  const node = a.order.find((n) => n.id === id);
  if (!node) throw new FilmkitError(invalid(`no scene or generated asset with id "${id}"`, { hint: `known: ${a.order.map((n) => n.id).join(", ")}` }));
  const prof = a.loaded.profiles.get(node.impl.profile)!.profile;
  const task = prof.tasks[node.impl.task]!;
  if (prof.runtime.type !== "cli" || !task.invocation) {
    throw new FilmkitError(
      invalid(`node "${id}" uses profile "${prof.metadata.name}" (runtime ${prof.runtime.type}${task.invocation ? "" : ", no invocation"}); filmkit run only executes cli profiles with an invocation`, {
        hint: prof.runtime.type === "none" ? "place the produces files directly" : "produce the files with the tool/skill, then re-run filmkit plan",
      }),
    );
  }
  for (const dep of node.inputs) {
    const st = a.state.nodes.get(dep);
    if (st && st.status !== "ready") throw new FilmkitError(invalid(`input "${dep}" is ${st.status}; produce it first`));
  }
  const cmd = taskCommand(a.loaded, node, task, task.invocation, `${prof.metadata.name}.tasks.${node.impl.task}.invocation`);
  if (cmd.errors.length) throw new FilmkitError(cmd.errors);
  const { argv } = cmd;

  // Snapshot which produces existed so a failure can leave exactly the previous state.
  const before = new Map<string, boolean>();
  for (const rel of Object.values(node.produces)) {
    const abs = resolve(a.loaded.dir, rel);
    before.set(abs, existsSync(abs));
    mkdirSync(dirname(abs), { recursive: true });
  }
  const r = exec(argv, { cwd: cmd.cwd });
  const cls = classifyExit(r.status, prof.runtime.exitCodes);
  if (cls !== "ok") {
    // Do not keep half-written outputs the tool may have created.
    for (const [abs, existed] of before) if (!existed && existsSync(abs)) rmSync(abs, { force: true });
    throw new FilmkitError(execFailure(r, cls, `run ${id}`));
  }
  const missing: ErrorDetail[] = [];
  for (const [type, rel] of Object.entries(node.produces) as [ProduceType, string][]) {
    if (!existsSync(resolve(a.loaded.dir, rel))) missing.push({ code: "tool-failure", message: `run ${id}: command succeeded but produces.${type} was not created: ${rel}` });
  }
  if (missing.length) throw new FilmkitError(missing);

  const lock = a.state.lock ?? emptyLock(a.loaded.path, a.filmSha256);
  lock.film = { path: a.loaded.path, sha256: a.filmSha256 };
  const fresh = observeNode(a.loaded, node, undefined, { probe: true });
  lock.nodes[id] = toLockNode(a.loaded, fresh);
  writeLock(a.loaded.dir, lock);
  return { id, argv, produces: node.produces as Record<string, string> };
}
