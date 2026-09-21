// Observed state of a project: which produces exist, what ffprobe says about
// them, and how that compares with the lock. `plan`, `status`, `build` and
// `validate` all start from here so they never disagree about what is ready.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type LoadedFilm, type Node, nodesOf } from "./film.ts";
import { paramsHash, sha256File } from "./hash.ts";
import { isStillImage, probeMedia } from "./probe.ts";
import { isGeneratedAsset, type Film, type Lock, type LockNode, type NodeStatus, type Probe, type ProduceType } from "./types.ts";

export interface ProduceState {
  path: string;
  exists: boolean;
  sha256?: string;
  probe?: Probe;
}

export interface NodeState {
  node: Node;
  status: NodeStatus;
  /** impl.params plus the content of every path it references (src/hash.ts). */
  paramsHash: string;
  produces: Partial<Record<ProduceType, ProduceState>>;
  /** From video/audio probes; undefined when nothing with a duration exists yet. */
  naturalDuration?: number;
}

export interface ProjectState {
  nodes: Map<string, NodeState>;
  lock?: Lock;
}

export interface ObserveOptions {
  /** Skip ffprobe (used by validate when only existence matters). */
  probe: boolean;
}

/** Every path any node in the film declares as a produce. */
function allProducePaths(film: Film): string[] {
  const paths: string[] = [];
  for (const asset of Object.values(film.assets)) if (isGeneratedAsset(asset)) paths.push(...Object.values(asset.produces));
  for (const scene of film.scenes) paths.push(...Object.values(scene.produces));
  return paths;
}

export function observe(loaded: LoadedFilm, lock: Lock | undefined, opts: ObserveOptions = { probe: true }): ProjectState {
  const nodes = new Map<string, NodeState>();
  for (const node of nodesOf(loaded.film)) {
    nodes.set(node.id, observeNode(loaded, node, lock?.nodes[node.id], opts));
  }
  return { nodes, lock };
}

export function observeNode(loaded: LoadedFilm, node: Node, previous: LockNode | undefined, opts: ObserveOptions): NodeState {
  // Directory params skip every declared produce (src/hash.ts): a tool handed a
  // directory must not go stale because a sibling node writes into it.
  const paramsHashValue = paramsHash(node.impl.params, loaded.dir, { produces: allProducePaths(loaded.film) });
  const produces: NodeState["produces"] = {};
  let existing = 0;
  let total = 0;
  let natural: number | undefined;
  for (const [type, rel] of Object.entries(node.produces) as [ProduceType, string][]) {
    total++;
    const abs = resolve(loaded.dir, rel);
    const exists = existsSync(abs);
    const ps: ProduceState = { path: rel, exists };
    if (exists) {
      existing++;
      ps.sha256 = sha256File(abs);
      if (opts.probe && (type === "video" || type === "audio" || type === "image")) {
        ps.probe = probeMedia(abs, loaded.dir);
        if ((type === "video" || type === "audio") && ps.probe.duration !== undefined && !isStillImage(ps.probe)) {
          natural = Math.max(natural ?? 0, ps.probe.duration);
        }
      }
    }
    produces[type] = ps;
  }
  let status: NodeStatus;
  if (existing === 0) status = "missing";
  else if (existing < total) status = "partial";
  else if (previous && previous.paramsHash !== paramsHashValue) status = "stale";
  else status = "ready";
  return { node, status, paramsHash: paramsHashValue, produces, naturalDuration: natural };
}

/** Lock entry for a node in its currently observed state. */
export function toLockNode(loaded: LoadedFilm, s: NodeState): LockNode {
  const prof = loaded.profiles.get(s.node.impl.profile)!.profile;
  const produces: LockNode["produces"] = {};
  for (const [type, p] of Object.entries(s.produces) as [ProduceType, ProduceState][]) {
    produces[type] = p.exists ? { path: p.path, sha256: p.sha256, ...(p.probe ? { probe: p.probe } : {}) } : { path: p.path };
  }
  return {
    kind: s.node.kind,
    status: s.status,
    profile: { name: prof.metadata.name, version: prof.metadata.version },
    task: s.node.impl.task,
    paramsHash: s.paramsHash,
    produces,
  };
}
