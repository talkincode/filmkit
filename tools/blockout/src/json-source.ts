// A JSON reader that remembers where every value came from, so a schema error at
// `subjects[0].keyframes[2].pos` can say "line 41, column 15". JSON.parse alone
// cannot; this is a small hand-rolled recursive descent over the same grammar.
// The values themselves still come from JSON.parse: this file only produces the
// path -> position index and the syntax error position.

import { fail, invalid } from "./errors.ts";

export interface Position {
  line: number;
  column: number;
}

export interface JsonSource {
  value: unknown;
  positions: Map<string, Position>;
}

export function pathToField(segments: (string | number)[]): string {
  let out = "";
  for (const s of segments) out += typeof s === "number" ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

export function parseLocated(text: string, origin: string): JsonSource {
  const positions = new Map<string, Position>();
  let i = 0;
  let line = 1;
  let col = 1;

  const err = (message: string): never => fail(invalid(`${origin}: invalid JSON: ${message}`, { line, column: col }));
  const advance = () => {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else col++;
    i++;
  };
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i]!)) advance();
  };
  const here = (): Position => ({ line, column: col });

  const string = (): string => {
    const start = i;
    advance(); // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") advance();
      advance();
    }
    if (i >= text.length) err("unterminated string");
    advance();
    return JSON.parse(text.slice(start, i)) as string;
  };

  const value = (path: (string | number)[]): void => {
    ws();
    positions.set(pathToField(path), here());
    const c = text[i];
    if (c === "{") {
      advance();
      ws();
      if (text[i] === "}") return advance();
      for (;;) {
        ws();
        if (text[i] !== '"') err("expected a property name");
        const key = string();
        ws();
        if (text[i] !== ":") err("expected ':'");
        advance();
        value([...path, key]);
        ws();
        if (text[i] === ",") {
          advance();
          continue;
        }
        if (text[i] === "}") return advance();
        err("expected ',' or '}'");
      }
    } else if (c === "[") {
      advance();
      ws();
      if (text[i] === "]") return advance();
      for (let n = 0; ; n++) {
        value([...path, n]);
        ws();
        if (text[i] === ",") {
          advance();
          continue;
        }
        if (text[i] === "]") return advance();
        err("expected ',' or ']'");
      }
    } else if (c === '"') {
      string();
    } else {
      const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
      if (!m) err(`unexpected ${c === undefined ? "end of input" : JSON.stringify(c)}`);
      for (let k = 0; k < m![0].length; k++) advance();
    }
  };

  value([]);
  ws();
  if (i < text.length) err("unexpected content after the document");
  return { value: JSON.parse(text), positions };
}
