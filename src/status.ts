// `filmkit status`: observe every node, write the lock, report intent vs. reality.

import type { Analysis } from "./project.ts";
import { emptyLock, writeLock } from "./lock.ts";
import { toLockNode } from "./state.ts";
import type { Lock, NodeStatus } from "./types.ts";

export interface StatusReport {
  film: string;
  nodes: { id: string; kind: "scene" | "asset"; status: NodeStatus; produces: Record<string, { path: string; exists: boolean }> }[];
  timeline: { total: number; complete: boolean };
  build?: Lock["build"] & { outputExists: boolean; upToDate: boolean };
}

export function writeStatus(a: Analysis): StatusReport {
  const lock: Lock = a.state.lock ?? emptyLock(a.loaded.path, a.filmSha256);
  lock.film = { path: a.loaded.path, sha256: a.filmSha256 };
  const nodes: StatusReport["nodes"] = [];
  const nextNodes: Lock["nodes"] = {};
  for (const node of a.order) {
    const s = a.state.nodes.get(node.id)!;
    // Keep the previously recorded paramsHash for stale nodes so they stay stale until re-produced.
    const entry = toLockNode(a.loaded, s);
    if (s.status === "stale" && lock.nodes[node.id]) entry.paramsHash = lock.nodes[node.id]!.paramsHash;
    nextNodes[node.id] = entry;
    nodes.push({
      id: node.id,
      kind: node.kind,
      status: s.status,
      produces: Object.fromEntries(Object.entries(s.produces).map(([t, p]) => [t, { path: p.path, exists: p.exists }])),
    });
  }
  lock.nodes = nextNodes;
  lock.timeline = {
    total: a.timeline.total,
    scenes: a.timeline.scenes.map((p) => ({ id: p.scene.id, start: p.start, end: p.end, duration: p.duration, estimated: p.estimated })),
  };
  writeLock(a.loaded.dir, lock);

  const report: StatusReport = {
    film: a.loaded.path,
    nodes,
    timeline: { total: a.timeline.total, complete: a.timeline.scenes.every((p) => !p.estimated) && nodes.every((n) => n.status === "ready") },
  };
  if (lock.build) {
    const outAbs = `${a.loaded.dir}/${lock.build.output.path}`;
    const exists = Bun.file(outAbs).size > 0;
    report.build = { ...lock.build, outputExists: exists, upToDate: exists && lock.build.filmSha256 === a.filmSha256 && nodes.every((n) => n.status === "ready") };
  }
  return report;
}

export function formatStatus(r: StatusReport): string {
  const lines = [`film: ${r.film}`, `timeline: ${r.timeline.total}s${r.timeline.complete ? "" : " (incomplete: some durations are estimates or nodes are not ready)"}`];
  for (const n of r.nodes) {
    const marks = Object.entries(n.produces).map(([t, p]) => `${p.exists ? "✓" : "✗"} ${t}=${p.path}`).join("  ");
    lines.push(`- ${n.id.padEnd(16)} ${n.status.padEnd(8)} ${marks}`);
  }
  if (r.build) lines.push(`build: ${r.build.output.path} ${r.build.outputExists ? (r.build.upToDate ? "(up to date)" : "(outdated)") : "(missing)"}${r.build.draft ? " [draft]" : ""}`);
  else lines.push("build: not built yet");
  return lines.join("\n");
}
