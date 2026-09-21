// Error contract shared by every command (docs/spec.md §6).
// One error class, one exit-code table, one JSON shape — so callers and tests
// can reason about failures without knowing which module raised them.

export type ErrorCode = "io" | "invalid-input" | "missing-dependency" | "tool-failure";

export const EXIT_CODES: Record<ErrorCode, number> = {
  io: 1,
  "invalid-input": 2,
  "missing-dependency": 3,
  "tool-failure": 4,
};

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  /** `a.b[0].c` path into the offending document, when known. */
  field?: string;
  line?: number;
  column?: number;
  hint?: string;
}

export class FilmkitError extends Error {
  readonly errors: ErrorDetail[];

  constructor(errors: ErrorDetail | ErrorDetail[]) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.map(formatDetail).join("\n"));
    this.name = "FilmkitError";
    this.errors = list;
  }

  /** Exit code is the most severe code among all collected errors. */
  get exitCode(): number {
    return Math.max(...this.errors.map((e) => EXIT_CODES[e.code]));
  }

  toJSON(): { errors: ErrorDetail[] } {
    return { errors: this.errors };
  }
}

export function formatDetail(e: ErrorDetail): string {
  const where = [e.field, e.line !== undefined ? `line ${e.line}` : undefined].filter(Boolean).join(" @ ");
  const head = where ? `[${e.code}] ${where}: ${e.message}` : `[${e.code}] ${e.message}`;
  return e.hint ? `${head}\n  hint: ${e.hint}` : head;
}

export function invalid(message: string, extra: Omit<ErrorDetail, "code" | "message"> = {}): ErrorDetail {
  return { code: "invalid-input", message, ...extra };
}

export function io(message: string, extra: Omit<ErrorDetail, "code" | "message"> = {}): ErrorDetail {
  return { code: "io", message, ...extra };
}

export function missingDependency(message: string, extra: Omit<ErrorDetail, "code" | "message"> = {}): ErrorDetail {
  return { code: "missing-dependency", message, ...extra };
}

export function toolFailure(message: string, extra: Omit<ErrorDetail, "code" | "message"> = {}): ErrorDetail {
  return { code: "tool-failure", message, ...extra };
}

/** Collects errors so `validate` can report everything at once instead of stopping at the first. */
export class ErrorCollector {
  readonly errors: ErrorDetail[] = [];
  add(detail: ErrorDetail): void {
    this.errors.push(detail);
  }
  get hasErrors(): boolean {
    return this.errors.length > 0;
  }
  throwIfAny(): void {
    if (this.hasErrors) throw new FilmkitError(this.errors);
  }
}
