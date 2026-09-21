// Placeholder table for Profile argv templates (spec §3.4).

import { inputPath, type LoadedFilm, type Node } from "./film.ts";
import { expandArgv } from "./vars.ts";
import type { ErrorDetail } from "./errors.ts";

export function templateTable(loaded: LoadedFilm, node: Node): Record<string, string | string[] | undefined> {
  const table: Record<string, string | string[] | undefined> = {
    "node.id": node.id,
    "film.dir": loaded.dir,
    "output.width": String(loaded.film.output.video.width),
    "output.height": String(loaded.film.output.video.height),
    "output.fps": String(loaded.film.output.video.fps),
  };
  for (const [k, v] of Object.entries(node.impl.params)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") table[`params.${k}`] = String(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) table[`params.${k}`] = v as string[];
  }
  for (const [type, p] of Object.entries(node.produces)) table[`produces.${type}`] = p;
  for (const id of node.inputs) table[`inputs.${id}`] = inputPath(loaded.film, id);
  return table;
}

export function expandTemplate(
  loaded: LoadedFilm,
  node: Node,
  template: string[],
  field: string,
): { argv: string[]; errors: ErrorDetail[] } {
  return expandArgv(template, templateTable(loaded, node), field);
}
