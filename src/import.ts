// Shared types and utilities for filmkit import commands.
// (Note: `import hyperstory` has been deprecated and removed).

export interface ImportResult {
  out: string;
  scenes: number;
  assets: number;
  /** Input fields that were mapped into metadata.annotations instead of a first-class field. */
  annotations: Record<string, unknown>;
  /** Input fields filmkit cannot express; the agent must decide what to do with them. */
  warnings: string[];
  /** Files the imported film references that do not exist yet (the asset plan). */
  missingFiles: string[];
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return out === "" ? "item" : /^[a-z0-9]/.test(out) ? out : `x-${out}`;
}

export function yamlStr(s: string): string {
  return JSON.stringify(s);
}
