// JSON Schema validation. One Ajv instance, compiled once; every document kind
// (Film, Profile, Lock, and each Profile task's paramsSchema) is checked here so
// error mapping to `field`/`line` lives in a single place.

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import filmSchema from "./schema/film.schema.json" with { type: "json" };
import profileSchema from "./schema/profile.schema.json" with { type: "json" };
import lockSchema from "./schema/lock.schema.json" with { type: "json" };
import { FilmkitError, invalid, type ErrorDetail } from "./errors.ts";
import { formatFieldPath, instancePathToSegments, positionOf, type PathSegment, type YamlSource } from "./yaml.ts";

export const SCHEMAS = {
  film: filmSchema,
  profile: profileSchema,
  lock: lockSchema,
} as const;

export type SchemaKind = keyof typeof SCHEMAS;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const compiled: Partial<Record<SchemaKind, ValidateFunction>> = {};

function validator(kind: SchemaKind): ValidateFunction {
  let v = compiled[kind];
  if (!v) {
    v = ajv.compile(SCHEMAS[kind]);
    compiled[kind] = v;
  }
  return v;
}

/**
 * Validate `src.value` against the named schema. Errors carry the YAML line of
 * the offending value and a `field` path; `fieldPrefix` lets callers nest the
 * report (e.g. `scenes[2].impl.params` for a Profile paramsSchema failure).
 */
export function validateAgainstSchema(kind: SchemaKind, src: YamlSource): void {
  const v = validator(kind);
  if (v(src.value)) return;
  throw new FilmkitError(ajvErrorsToDetails(v.errors ?? [], src, [], src.path));
}

/** Compile a user-supplied JSON Schema (a Profile task's paramsSchema). */
export function compileParamsSchema(schema: Record<string, unknown>, field: string, src: YamlSource): ValidateFunction {
  // Unknown additionalProperties defaults to false (spec §3.3): opaque params
  // must still be closed so typos surface as errors instead of silent no-ops.
  const closed = schema.type === "object" && schema.additionalProperties === undefined
    ? { ...schema, additionalProperties: false }
    : schema;
  try {
    // A private Ajv so a bad user schema cannot poison the core instance.
    const local = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    return local.compile(closed);
  } catch (err) {
    const pos = positionOf(src, field.split(".").flatMap(splitField));
    throw new FilmkitError(
      invalid(`paramsSchema cannot be compiled: ${(err as Error).message}`, { field, line: pos?.line, column: pos?.column }),
    );
  }
}

export function validateParams(
  validate: ValidateFunction,
  params: unknown,
  filmSrc: YamlSource,
  paramsPath: PathSegment[],
): ErrorDetail[] {
  if (validate(params)) return [];
  return ajvErrorsToDetails(validate.errors ?? [], filmSrc, paramsPath, filmSrc.path);
}

function ajvErrorsToDetails(errors: ErrorObject[], src: YamlSource, prefix: PathSegment[], file: string): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    // Skip the noisy wrapper errors ajv emits alongside the real cause.
    if (e.keyword === "if" || e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "allOf") continue;
    let path = [...prefix, ...instancePathToSegments(e.instancePath)];
    let message: string;
    switch (e.keyword) {
      case "additionalProperties":
        path = [...path, String(e.params.additionalProperty)];
        message = `unknown field "${e.params.additionalProperty}"`;
        break;
      case "required":
        message = `missing required field "${e.params.missingProperty}"`;
        break;
      case "enum":
        message = `must be one of: ${(e.params.allowedValues as unknown[]).map(String).join(", ")}`;
        break;
      case "const":
        message = `must be ${JSON.stringify(e.params.allowedValue)}`;
        break;
      case "not":
        message = "combination of fields is not allowed here";
        break;
      default:
        message = e.message ?? e.keyword;
    }
    const field = formatFieldPath(path) || "(root)";
    const key = `${field}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pos = positionOf(src, path);
    out.push(invalid(`${file}: ${message}`, { field, line: pos?.line, column: pos?.column }));
  }
  if (out.length === 0) out.push(invalid(`${file}: does not match schema`));
  return out;
}

function splitField(seg: string): PathSegment[] {
  // "scenes[2]" -> ["scenes", 2]
  const m = /^([^[]+)((\[\d+\])*)$/.exec(seg);
  if (!m) return [seg];
  const parts: PathSegment[] = [m[1]!];
  for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) parts.push(Number(idx[1]));
  return parts;
}
