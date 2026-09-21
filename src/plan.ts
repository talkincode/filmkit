// `filmkit plan`: the agent's work order (spec §6.1).

import { inputPath } from "./film.ts";
import type { Analysis } from "./project.ts";
import type { MissingFile } from "./project.ts";
import type { Intent, NodeStatus, RuntimeType } from "./types.ts";

export interface PlanNode {
  id: string;
  kind: "scene" | "asset";
  status: NodeStatus | "blocked";
  profile: { name: string; version: string; runtime: RuntimeType };
  task: string;
  params: Record<string, unknown>;
  inputs: Record<string, string | undefined>;
  produces: Record<string, string>;
  executor: "filmkit run" | "agent" | "place files";
  intent?: Intent;
  reason: string;
}

export interface Plan {
  film: string;
  timeline: { total: number; scenes: { id: string; start: number; end: number; duration: number; estimated: boolean }[] };
  nodes: PlanNode[];
  /** Files the film references that are not in place yet; nobody's `impl` produces them. */
  missingFiles: MissingFile[];
}

export function makePlan(a: Analysis): Plan {
  const nodes: PlanNode[] = [];
  for (const node of a.order) {
    const s = a.state.nodes.get(node.id)!;
    const blocked = a.blocked.has(node.id);
    if (s.status === "ready" && !blocked) continue;
    const prof = a.loaded.profiles.get(node.impl.profile)!.profile;
    const task = prof.tasks[node.impl.task]!;
    const scene = node.kind === "scene" ? a.loaded.film.scenes.find((x) => x.id === node.id) : undefined;
    const executor: PlanNode["executor"] =
      prof.runtime.type === "none" ? "place files" : prof.runtime.type === "cli" && task.invocation ? "filmkit run" : "agent";
    nodes.push({
      id: node.id,
      kind: node.kind,
      status: s.status === "ready" ? "blocked" : s.status,
      profile: { name: prof.metadata.name, version: prof.metadata.version, runtime: prof.runtime.type },
      task: node.impl.task,
      params: node.impl.params,
      inputs: Object.fromEntries(node.inputs.map((i) => [i, inputPath(a.loaded.film, i)])),
      produces: node.produces as Record<string, string>,
      executor,
      ...(scene?.intent ? { intent: scene.intent } : {}),
      reason: reasonFor(s.status, blocked, Object.entries(s.produces).filter(([, p]) => !p.exists).map(([t]) => t)),
    });
  }
  return {
    film: a.loaded.path,
    timeline: {
      total: a.timeline.total,
      scenes: a.timeline.scenes.map((p) => ({ id: p.scene.id, start: p.start, end: p.end, duration: p.duration, estimated: p.estimated })),
    },
    nodes,
    missingFiles: a.missingFiles,
  };
}

function reasonFor(status: NodeStatus, blocked: boolean, missing: string[]): string {
  const parts: string[] = [];
  if (status === "missing" || status === "partial") parts.push(`missing produces: ${missing.join(", ")}`);
  if (status === "stale") parts.push("impl.params changed since the produces were recorded");
  if (blocked) parts.push("an input node is not ready");
  return parts.join("; ");
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`timeline: ${plan.timeline.total}s`);
  for (const s of plan.timeline.scenes) {
    lines.push(`  ${s.id.padEnd(16)} ${fmt(s.start)} -> ${fmt(s.end)}  (${fmt(s.duration)}s${s.estimated ? ", estimated" : ""})`);
  }
  if (plan.missingFiles.length) {
    lines.push(`files to place (${plan.missingFiles.length}):`);
    for (const m of plan.missingFiles) {
      lines.push(`- ${m.path}  (${m.field}${m.usedBy.length ? `; needed by ${m.usedBy.join(", ")}` : "; unused"})`);
    }
  }
  if (plan.nodes.length === 0 && plan.missingFiles.length === 0) {
    lines.push("nothing to do: every node is ready");
    return lines.join("\n");
  }
  lines.push(`pending nodes (${plan.nodes.length}):`);
  for (const n of plan.nodes) {
    lines.push(`- ${n.id} [${n.status}] ${n.profile.name}@${n.profile.version} / ${n.task}  -> ${n.executor}`);
    lines.push(`    reason:   ${n.reason}`);
    if (Object.keys(n.params).length) lines.push(`    params:   ${JSON.stringify(n.params)}`);
    if (Object.keys(n.inputs).length) lines.push(`    inputs:   ${Object.entries(n.inputs).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push(`    produces: ${Object.entries(n.produces).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (n.intent?.description) lines.push(`    intent:   ${n.intent.description}`);
  }
  return lines.join("\n");
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(7);
}
