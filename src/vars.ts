// `${vars.x}` static substitution (spec §1.3) and argv template placeholders
// (spec §3.4). Both are deliberately the same tiny mechanism: find `${...}`,
// look the name up in a flat table, replace. No expressions, no nesting.

import { formatFieldPath, type PathSegment } from "./yaml.ts";
import { invalid, type ErrorDetail } from "./errors.ts";

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const VAR_REF = /^vars\.([a-z0-9][a-z0-9-]{0,62})$/;
/** Placeholders that argv templates resolve later (spec §3.4); legal only inside impl.params. */
const LATE_REF = /^(produces|inputs|params|node|film|output)\.[A-Za-z0-9_.-]+$/;

/**
 * Walk a parsed document and replace `${vars.name}` inside every string.
 * Returns the substituted copy plus any errors (unknown var, unsupported syntax).
 */
export function substituteVars(
  value: unknown,
  vars: Record<string, string | number | boolean>,
): { value: unknown; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const out = walk(value, [], (str, path) => {
    const inParams = path.includes("impl") && path[path.indexOf("impl") + 1] === "params";
    return str.replace(PLACEHOLDER, (whole, inner: string) => {
      const m = VAR_REF.exec(inner);
      if (!m && inParams && LATE_REF.test(inner)) return whole; // resolved by the Profile's argv template
      if (!m) {
        errors.push(
          invalid(`unsupported substitution "${whole}"; only \${vars.<name>} is allowed`, {
            field: formatFieldPath(path),
          }),
        );
        return whole;
      }
      const name = m[1]!;
      if (!(name in vars)) {
        errors.push(invalid(`undefined variable "${name}"`, { field: formatFieldPath(path) }));
        return whole;
      }
      return String(vars[name]);
    });
  });
  return { value: out, errors };
}

function walk(value: unknown, path: PathSegment[], fn: (s: string, path: PathSegment[]) => string): unknown {
  if (typeof value === "string") return fn(value, path);
  if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, i], fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...path, k], fn);
    return out;
  }
  return value;
}

/**
 * Expand an argv template. `table` maps full placeholder names
 * (`params.scene`, `produces.video`, `inputs.cover`, `node.id`, ...) to values.
 * A string[] value is only legal when the placeholder is the whole argv element
 * (used by filmkit/ffmpeg's `${params.args}`), in which case it splices.
 */
export function expandArgv(
  template: string[],
  table: Record<string, string | string[] | undefined>,
  field: string,
): { argv: string[]; errors: ErrorDetail[] } {
  const argv: string[] = [];
  const errors: ErrorDetail[] = [];
  const expandScalar = (element: string, where: string): string =>
    element.replace(PLACEHOLDER, (ph, inner: string) => {
      const v = table[inner];
      if (v === undefined) {
        errors.push(invalid(`unknown placeholder "${ph}"`, { field: where }));
        return ph;
      }
      if (Array.isArray(v)) {
        errors.push(invalid(`array placeholder "${ph}" must be a whole argv element`, { field: where }));
        return ph;
      }
      return v;
    });
  template.forEach((element, i) => {
    const where = `${field}[${i}]`;
    const whole = /^\$\{([^}]*)\}$/.exec(element);
    const v = whole ? table[whole[1]!] : undefined;
    if (whole && Array.isArray(v)) {
      // Spliced array (filmkit/ffmpeg's ${params.args}); its elements may hold
      // ${produces.*} / ${inputs.*} placeholders themselves.
      v.forEach((el, j) => argv.push(expandScalar(el, `${where}(${whole[1]}[${j}])`)));
      return;
    }
    argv.push(expandScalar(element, where));
  });
  return { argv, errors };
}
