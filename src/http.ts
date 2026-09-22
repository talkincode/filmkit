// `runtime.type: http` — filmkit calls a generation API itself (spec §3.5).
//
// The spec is declarative on purpose: a request, an optional poll loop for
// async APIs, and where the bytes come from. filmkit stays ignorant of any
// provider's semantics — no Seedance or Gemini fields live in this file, only
// placeholders and JSON paths. Credentials are read from the environment by
// name and never logged.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FilmkitError, invalid, missingDependency, toolFailure, type ErrorDetail } from "./errors.ts";
import type { LoadedFilm, Node } from "./film.ts";
import { inputPath } from "./film.ts";
import type { HttpAssert, HttpRequest, HttpSpec } from "./types.ts";

export interface HttpRunResult {
  /** Requests actually performed, with their status codes — for `--json` and logs. */
  requests: { method: string; url: string; status: number }[];
  produced: string;
  /** Bytes written. */
  bytes: number;
}

/**
 * One http task, as handed to the worker process. Credentials are deliberately
 * absent: the worker reads them from its own environment (inherited), so a key
 * never appears in an argv, a temp file or a log line.
 */
export interface HttpJob {
  spec: HttpSpec;
  table: TemplateTable;
  /** Absolute path the bytes must land on. */
  target: string;
}

export interface TemplateTable {
  [name: string]: string;
}

const PLACEHOLDER = /\$\{([^}]*?)(\?)?\}/g;

/** Build the substitution table for one node (spec §3.4). */
export function httpTable(loaded: LoadedFilm, node: Node): TemplateTable {
  const out: TemplateTable = {
    "node.id": node.id,
    "film.dir": loaded.dir,
    "output.width": String(loaded.film.output.video.width),
    "output.height": String(loaded.film.output.video.height),
    "output.fps": String(loaded.film.output.video.fps),
  };
  for (const [k, v] of Object.entries(node.impl.params)) {
    if (typeof v === "string") out[`params.${k}`] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[`params.${k}`] = String(v);
    else if (Array.isArray(v)) out[`params.${k}`] = v.map(String).join(",");
  }
  for (const id of node.inputs) {
    const p = inputPath(loaded.film, id);
    if (p !== undefined) out[`inputs.${id}`] = p;
  }
  for (const [type, p] of Object.entries(node.produces)) out[`produces.${type}`] = p;
  return out;
}

/** Flatten a JSON value into `a.b.0.c` paths, so `${create.content.video_url}` works. */
function flatten(value: unknown, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") {
      if (Array.isArray(v)) v.forEach((item, i) => walk(item, path === "" ? String(i) : `${path}.${i}`));
      else for (const [k, item] of Object.entries(v as Record<string, unknown>)) walk(item, path === "" ? k : `${path}.${k}`);
      return;
    }
    out.push([path, String(v)]);
  };
  walk(value, prefix);
  return out;
}

/** Read a dotted path out of a JSON value (arrays use numeric segments). */
export function pathValue(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}

/**
 * Substitute placeholders in any JSON value. `?`-marked placeholders drop the
 * enclosing key (or array element) when unset; a plain placeholder that is unset
 * is an error. `${env.NAME}` is required and never printed anywhere.
 */
export function substituteHttp(
  value: unknown,
  tableIn: TemplateTable,
  field: string,
): { value: unknown; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const lookup = (name: string): { value?: string; present: boolean } => {
    if (name.startsWith("env.")) {
      const envName = name.slice("env.".length);
      const raw = process.env[envName];
      return raw === undefined || raw === "" ? { present: false } : { value: raw, present: true };
    }
    // `${base64:params.image}` sends a local file's bytes inline (the shape some
    // APIs want), `${mimeType:params.image}` its media type from the extension.
    if (name.startsWith("base64:") || name.startsWith("mimeType:")) {
      const kind = name.startsWith("base64:") ? "base64" : "mimeType";
      const inner = name.slice(kind.length + 1);
      const target = lookup(inner);
      if (!target.present || target.value === undefined) return { present: false };
      const path = target.value;
      if (kind === "mimeType") return { value: mimeOf(path), present: true };
      if (!existsSync(path)) {
        errors.push(invalid(`cannot inline ${path}: file not found`, { field: `${field} (${name})` }));
        return { present: false };
      }
      return { value: readFileSync(path).toString("base64"), present: true };
    }
    const v = tableIn[name];
    return v === undefined ? { present: false } : { value: v, present: true };
  };
  const expandString = (text: string, where: string): string =>
    text.replace(PLACEHOLDER, (whole, inner: string) => {
      const optional = inner.endsWith("?");
      const name = optional ? inner.slice(0, -1) : inner;
      if (!/^((env|params|inputs|produces|node|film|output|create)\.[A-Za-z0-9_.-]+|(base64|mimeType):[A-Za-z0-9_.-]+)$/.test(name)) {
        errors.push(invalid(`unsupported placeholder "${whole}" in the http spec`, { field: where }));
        return whole;
      }
      const found = lookup(name);
      if (!found.present) {
        if (optional) return "";
        errors.push(
          invalid(
            name.startsWith("env.")
              ? `environment variable ${name.slice("env.".length)} is not set`
              : `placeholder "${whole}" has no value`,
            { field: where, hint: name.startsWith("env.") ? "set it in the environment; filmkit never stores credentials" : undefined },
          ),
        );
        return whole;
      }
      return found.value!;
    });

  // An element (array item, or object key whose value became empty) is dropped
  // when it needed an unset optional placeholder — the same rule the argv
  // templates use, so `content: [{text}, {image_url: "${inputs.image?}"}]` sends
  // just the text for a text-only job.
  const walk = (v: unknown, path: string): { value: unknown; dropped: boolean } => {
    if (typeof v === "string") {
      const whole = /^\$\{([^}]*?)\?\}$/.exec(v);
      if (whole) {
        const name = whole[1]!;
        const found = lookup(name);
        return found.present ? { value: found.value, dropped: false } : { value: undefined, dropped: true };
      }
      const expanded = expandString(v, path);
      return { value: expanded, dropped: false };
    }
    if (Array.isArray(v)) {
      const items: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const item = walk(v[i], `${path}[${i}]`);
        if (item.dropped) continue;
        items.push(item.value);
      }
      return { value: items, dropped: false };
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      let allDropped = true;
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const walked = walk(item, `${path}.${k}`);
        if (walked.dropped) continue;
        out[k] = walked.value;
        allDropped = false;
      }
      // An object whose every key was optional-and-unset disappears with its parent element.
      if (allDropped && Object.keys(v as Record<string, unknown>).length > 0) return { value: undefined, dropped: true };
      return { value: out, dropped: false };
    }
    return { value: v, dropped: false };
  };

  const out = walk(value, field);
  return { value: out.value, errors };
}

/** HTTP status → filmkit exit class (spec §3.5). */
export function classifyStatus(status: number): "ok" | "invalid-input" | "missing-dependency" | "tool-failure" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "missing-dependency";
  if (status === 429) return "tool-failure";
  if (status >= 400 && status < 500) return "invalid-input";
  return "tool-failure";
}

async function call(
  request: HttpRequest,
  tableIn: TemplateTable,
  field: string,
  log: HttpRunResult["requests"],
): Promise<unknown> {
  const { value: url, errors: urlErrors } = substituteHttp(request.url, tableIn, `${field}.url`);
  const errors = [...urlErrors];
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    errors.push(invalid(`http url must be an absolute http(s) URL`, { field: `${field}.url` }));
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    const { value: hv, errors: headerErrors } = substituteHttp(v, tableIn, `${field}.headers.${k}`);
    errors.push(...headerErrors);
    if (typeof hv === "string") headers[k] = hv;
  }
  let body: string | undefined;
  if (request.json !== undefined) {
    const { value: json, errors: jsonErrors } = substituteHttp(request.json, tableIn, `${field}.json`);
    errors.push(...jsonErrors);
    body = JSON.stringify(json);
    headers["Content-Type"] ??= "application/json";
  }
  if (errors.length) throw new FilmkitError(errors);

  const method = request.method ?? (body ? "POST" : "GET");
  // A synchronous generation call can take minutes; `timeout` bounds it.
  let timeoutMs: number | undefined;
  if (request.timeout !== undefined) {
    const { value: resolved, errors: timeoutErrors } = substituteHttp(request.timeout, tableIn, `${field}.timeout`);
    errors.push(...timeoutErrors);
    const n = Number(resolved);
    if (Number.isFinite(n) && n > 0) timeoutMs = n * 1000;
  }
  if (errors.length) throw new FilmkitError(errors);
  let response: Response;
  try {
    response = await fetch(url as string, { method, headers, body, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
  } catch (err) {
    const why = (err as Error).name === "TimeoutError" ? `timed out after ${(timeoutMs ?? 0) / 1000}s` : (err as Error).message;
    throw new FilmkitError(toolFailure(`${field}: ${method} ${url} failed: ${why}`));
  }
  const text = await response.text();
  log.push({ method, url: url as string, status: response.status });
  if (!response.ok) {
    const cls = classifyStatus(response.status);
    const hint = text.slice(0, 400);
    throw new FilmkitError({
      code: cls === "ok" ? "tool-failure" : cls,
      message: `${field}: ${method} ${url} returned HTTP ${response.status}`,
      hint,
    });
  }
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new FilmkitError(toolFailure(`${field}: response was not JSON`, { hint: text.slice(0, 200) }));
  }
}

function assertMatches(assert: HttpAssert, response: unknown): boolean {
  return JSON.stringify(pathValue(response, assert.path)) === JSON.stringify(assert.equals);
}

/** Run one http task: create → (poll) → fetch the file → land it atomically. */
export async function runHttpJob(job: HttpJob): Promise<HttpRunResult> {
  const { spec, table: initialTable, target } = job;
  const requests: HttpRunResult["requests"] = [];

  let response = await call(spec.create, initialTable, "http.create", requests);

  if (spec.poll) {
    // `every`/`timeout` may be templated, so resolve them through the table too.
    const seconds = (value: number | string | undefined, fallback: number, field: string): number => {
      if (value === undefined) return fallback;
      if (typeof value === "number") return value;
      // A whole-value optional placeholder (`"${params.timeout?}"`) that is unset
      // means "use the default", not "zero".
      const whole = /^\$\{([^}]*?)\?\}$/.exec(value);
      if (whole) {
        const name = whole[1]!;
        const present = name.startsWith("env.") ? Boolean(process.env[name.slice(4)]) : initialTable[name] !== undefined;
        if (!present) return fallback;
      }
      const { value: resolved, errors } = substituteHttp(value, initialTable, field);
      if (errors.length) throw new FilmkitError(errors);
      const n = Number(resolved);
      if (!Number.isFinite(n) || n <= 0) {
        throw new FilmkitError(invalid(`http.poll.${field.split(".").pop()} must resolve to a positive number`, { hint: `got ${JSON.stringify(resolved)}` }));
      }
      return n;
    };
    const every = seconds(spec.poll.every, 5, "http.poll.every") * 1000;
    const timeout = seconds(spec.poll.timeout, 900, "http.poll.timeout") * 1000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (assertMatches(spec.poll.until, response)) break;
      for (const fail of spec.poll.failed ?? []) {
        if (assertMatches(fail, response)) {
          throw new FilmkitError(
            toolFailure(`http.poll: the API reported ${fail.path} = ${JSON.stringify(fail.equals)}`, {
              hint: JSON.stringify(pathValue(response, "error") ?? response).slice(0, 300),
            }),
          );
        }
      }
      if (Date.now() > deadline) {
        throw new FilmkitError(toolFailure(`http.poll: gave up after ${timeout / 1000}s`, { hint: `last status: ${JSON.stringify(pathValue(response, spec.poll.until.path))}` }));
      }
      await new Promise((r) => setTimeout(r, every));
      response = await call(spec.poll as HttpRequest, { ...initialTable, ...tableFrom(response) }, "http.poll", requests);
    }
  }

  // ---- fetch the bytes ----
  const responseTable = { ...initialTable, ...tableFrom(response) };
  const download = spec.output.download;
  const inline = spec.output.inline;
  let bytes: Uint8Array;
  if (download) {
    const { value: url, errors } = substituteHttp(download.path, responseTable, "http.output.download.path");
    if (errors.length) throw new FilmkitError(errors);
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new FilmkitError(invalid(`http.output.download: path "${download.path}" did not resolve to a URL`, { hint: `got ${JSON.stringify(url)}` }));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(download.headers ?? {})) {
      const { value: hv, errors: headerErrors } = substituteHttp(v, responseTable, `http.output.download.headers.${k}`);
      if (headerErrors.length) throw new FilmkitError(headerErrors);
      if (typeof hv === "string") headers[k] = hv;
    }
    const res = await fetch(url, { headers });
    requests.push({ method: "GET", url, status: res.status });
    if (!res.ok) throw new FilmkitError(toolFailure(`http.output.download: HTTP ${res.status} for ${url}`));
    bytes = new Uint8Array(await res.arrayBuffer());
  } else if (inline) {
    const raw = pathValue(response, inline.path);
    if (typeof raw !== "string") {
      // The Profile author needs to see what actually came back to fix the path,
      // so the hint carries a truncated dump of the response.
      throw new FilmkitError(
        invalid(`http.output.inline: path "${inline.path}" did not resolve to a string`, {
          hint: `got ${JSON.stringify(raw)} — response: ${JSON.stringify(response).slice(0, 400)}`,
        }),
      );
    }
    bytes = inline.base64 ? new Uint8Array(Buffer.from(raw, "base64")) : new TextEncoder().encode(raw);
  } else {
    throw new FilmkitError(invalid("http.output needs either download or inline"));
  }

  // ---- land it atomically, like every other produce ----
  const tmp = `${target}.part`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new FilmkitError({ code: "io", message: `cannot write ${target}: ${(err as Error).message}` });
  }
  if (!existsSync(target)) throw new FilmkitError(toolFailure(`http: ${target} was not written`));
  return { requests, produced: target, bytes: bytes.length };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** `${create.<path>}` entries for a response (spec §3.5). */
function tableFrom(response: unknown): TemplateTable {
  const out: TemplateTable = {};
  for (const [path, value] of flatten(response)) out[`create.${path}`] = value;
  return out;
}
