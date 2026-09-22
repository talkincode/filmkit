// `filmkit run <id>`: execute one cli node's invocation template and record
// the result (spec §6). Anything not `cli` + `invocation` is the agent's job.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { FilmkitError, invalid, toolFailure, type ErrorDetail } from "./errors.ts";
import { classifyExit, exec, execFailure } from "./exec.ts";
import type { Analysis } from "./project.ts";
import { observeNode, toLockNode } from "./state.ts";
import { taskCommand } from "./template.ts";
import { httpTable, type HttpJob } from "./http.ts";
import { emptyLock, writeLock } from "./lock.ts";
import type { ProduceType } from "./types.ts";

export interface RunResult {
  id: string;
  argv?: string[];
  /** For `runtime.type: http`: the requests that were performed. */
  requests?: { method: string; url: string; status: number }[];
  produces: Record<string, string>;
}

export function runNode(a: Analysis, id: string): RunResult {
  const node = a.order.find((n) => n.id === id);
  if (!node) throw new FilmkitError(invalid(`no scene or generated asset with id "${id}"`, { hint: `known: ${a.order.map((n) => n.id).join(", ")}` }));
  const prof = a.loaded.profiles.get(node.impl.profile)!.profile;
  const task = prof.tasks[node.impl.task]!;

  // A referenced file that is not in place is a film-level problem, reported the
  // same way `build` reports it (with the field path), before any tool or API runs.
  const missingInputs = a.missingFiles.filter((m) => m.usedBy.includes(id));
  if (missingInputs.length) {
    throw new FilmkitError(
      missingInputs.map((m) => invalid(`referenced file is not in place: ${m.path}`, { field: m.field, hint: `needed by: ${m.usedBy.join(", ")}` })),
    );
  }

  if (prof.runtime.type === "http") {
    if (!task.http) {
      throw new FilmkitError(invalid(`node "${id}" uses the http runtime but task "${node.impl.task}" declares no http spec`, { hint: `add an http: block to the task in ${prof.metadata.name}` }));
    }
    for (const dep of node.inputs) {
      const st = a.state.nodes.get(dep);
      if (st && st.status !== "ready") throw new FilmkitError(invalid(`input "${dep}" is ${st.status}; produce it first`));
    }
    const target = node.produces.video ?? node.produces.image ?? node.produces.audio ?? node.produces.file;
    if (!target) throw new FilmkitError(invalid(`node "${id}" declares no file produce for an http task`));
    const job: HttpJob = { spec: task.http, table: httpTable(a.loaded, node), target: resolve(a.loaded.dir, target) };
    const r = spawnSync("bun", [new URL("./http-worker.ts", import.meta.url).pathname], {
      cwd: a.loaded.dir,
      // stdin, not argv: a resolved Authorization header must not show up in `ps`.
      input: JSON.stringify(job),
      // Explicit: Bun's spawnSync does not pick up process.env mutations made
      // after startup, so a key exported by a caller would otherwise be invisible.
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw new FilmkitError(toolFailure(`http worker failed to start: ${r.error.message}`));
    let parsed: { requests?: RunResult["requests"]; errors?: ErrorDetail[] } = {};
    try {
      parsed = JSON.parse(String(r.stdout).trim().split("\n").pop() ?? "{}") as typeof parsed;
    } catch {
      throw new FilmkitError(toolFailure(`http worker returned unparsable output`, { hint: `${String(r.stdout).slice(0, 200)}${String(r.stderr).slice(0, 200)}` }));
    }
    if (parsed.errors?.length) throw new FilmkitError(parsed.errors);
    if (r.status !== 0) throw new FilmkitError(toolFailure(`http worker exited with ${r.status}`, { hint: String(r.stderr).slice(0, 300) }));
    for (const [type, rel] of Object.entries(node.produces) as [ProduceType, string][]) {
      if (!existsSync(resolve(a.loaded.dir, rel))) {
        throw new FilmkitError(toolFailure(`run ${id}: the API call succeeded but produces.${type} was not created: ${rel}`));
      }
    }
    const lock = a.state.lock ?? emptyLock(a.loaded.path, a.filmSha256);
    lock.film = { path: a.loaded.path, sha256: a.filmSha256 };
    lock.nodes[id] = toLockNode(a.loaded, observeNode(a.loaded, node, undefined, { probe: true }));
    writeLock(a.loaded.dir, lock);
    return { id, requests: parsed.requests, produces: node.produces as Record<string, string> };
  }

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
