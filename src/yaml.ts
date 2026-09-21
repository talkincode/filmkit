// YAML loading with source positions. Every document filmkit reads goes through
// `loadYamlFile`, so error `field`/`line` reporting has one implementation.

import { existsSync, readFileSync } from "node:fs";
import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { FilmkitError, invalid, io } from "./errors.ts";

export type PathSegment = string | number;

export interface YamlSource {
  path: string;
  text: string;
  doc: Document;
  lineCounter: LineCounter;
  /** Plain JS value of the document (no YAML node wrappers). */
  value: unknown;
}

export function loadYamlFile(path: string): YamlSource {
  if (!existsSync(path)) throw new FilmkitError(io(`file not found: ${path}`));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new FilmkitError(io(`cannot read ${path}: ${(err as Error).message}`));
  }
  return parseYamlText(text, path);
}

export function parseYamlText(text: string, path: string): YamlSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new FilmkitError(
      doc.errors.map((e) => {
        const pos = e.linePos?.[0];
        return invalid(`YAML syntax error in ${path}: ${e.message.split("\n")[0]}`, {
          line: pos?.line,
          column: pos?.col,
        });
      }),
    );
  }
  const value = doc.toJS({ mapAsMap: false });
  return { path, text, doc, lineCounter, value };
}

/** Resolve `["scenes", 0, "impl"]` to the 1-based line/column of that value in the source. */
export function positionOf(src: YamlSource, path: PathSegment[]): { line: number; column: number } | undefined {
  // Walk up from the full path so that errors about missing fields still point
  // at the nearest enclosing node that does exist.
  for (let depth = path.length; depth >= 0; depth--) {
    const node = depth === 0 ? src.doc.contents : src.doc.getIn(path.slice(0, depth), true);
    if (isNode(node) && node.range) {
      const pos = src.lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return undefined;
}

/** `["scenes", 0, "impl", "params"]` -> `scenes[0].impl.params` */
export function formatFieldPath(path: PathSegment[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** Inverse of ajv's `instancePath` (`/scenes/0/impl`) into segments. */
export function instancePathToSegments(instancePath: string): PathSegment[] {
  if (instancePath === "") return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((raw) => {
      const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(seg) ? Number(seg) : seg;
    });
}
