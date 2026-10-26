// Error contract for vflow-pull: the same codes and exit numbers as filmkit
// (0 ok, 1 io, 2 invalid input, 3 missing dependency, 4 tool failure), the same
// `{ errors: [{ code, message, field?, hint? }] }` shape under --json.

export type ErrorCode = "io" | "invalid-input" | "missing-dependency" | "tool-failure";

export const EXIT_CODES: Record<ErrorCode, number> = {
  io: 1,
  "invalid-input": 2,
  "missing-dependency": 3,
  "tool-failure": 4,
};

export interface Detail {
  code: ErrorCode;
  message: string;
  /** `a.b[0].c` path into the offending document, when known. */
  field?: string;
  hint?: string;
}

export class PullError extends Error {
  constructor(readonly details: Detail[]) {
    super(details.map((d) => d.message).join("; "));
    this.name = "PullError";
  }

  /** The most severe code wins, as in filmkit. */
  get exitCode(): number {
    return Math.max(...this.details.map((d) => EXIT_CODES[d.code]));
  }
}

type Extra = Omit<Detail, "code" | "message">;
const detail = (code: ErrorCode) => (message: string, extra: Extra = {}): Detail => ({ code, message, ...extra });

export const io = detail("io");
export const invalid = detail("invalid-input");
export const missingDependency = detail("missing-dependency");
export const toolFailure = detail("tool-failure");

export function fail(...details: Detail[]): never {
  throw new PullError(details);
}
