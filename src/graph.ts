// Dependency graph over producible nodes. Edges come from `inputs`; the
// timeline itself is not an edge (scenes do not depend on their neighbours).

import { ErrorCollector, invalid } from "./errors.ts";
import { at, type LoadedFilm, type Node, nodesOf } from "./film.ts";
import { formatFieldPath } from "./yaml.ts";

/** Deterministic topological order: dependencies first, ties broken by declaration order. */
export function topoOrder(loaded: LoadedFilm, errors: ErrorCollector): Node[] {
  const nodes = nodesOf(loaded.film);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, "visiting" | "done">();
  const order: Node[] = [];

  const visit = (n: Node, stack: string[]): void => {
    const s = state.get(n.id);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(n.id)), n.id].join(" -> ");
      errors.add(at(invalid(`dependency cycle: ${cycle}`, { field: formatFieldPath([...n.field, "inputs"]) }), loaded.src));
      return;
    }
    state.set(n.id, "visiting");
    for (const dep of n.inputs) {
      const d = byId.get(dep);
      if (d) visit(d, [...stack, n.id]); // static assets are not nodes; nothing to order
    }
    state.set(n.id, "done");
    order.push(n);
  };

  for (const n of nodes) visit(n, []);
  return order;
}

/** Ids of every node downstream of `id` (transitively), for stale propagation in `plan`. */
export function downstreamOf(nodes: Node[], id: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (out.has(n.id)) continue;
      if (n.inputs.some((i) => i === id || out.has(i))) {
        out.add(n.id);
        changed = true;
      }
    }
  }
  return out;
}
