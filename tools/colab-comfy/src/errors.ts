// Exit codes (PLAN §5.4) and the error type the CLI turns into --json output.

export const EXIT = {
  ok: 0,
  io: 1,
  invalidInput: 2,
  missingDependency: 3,
  toolFailure: 4,
  needsConfirmation: 5,
} as const;

export interface Detail {
  code: string;
  message: string;
  field?: string;
  hint?: string;
}

export class ColabComfyError extends Error {
  constructor(
    readonly exitCode: number,
    readonly details: Detail[],
  ) {
    super(details.map((d) => d.message).join("; "));
  }
}

export function invalid(message: string, field?: string, hint?: string): Detail {
  return { code: "invalid-input", message, ...(field ? { field } : {}), ...(hint ? { hint } : {}) };
}
