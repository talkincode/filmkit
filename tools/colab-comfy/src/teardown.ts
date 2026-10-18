// STOP + VERIFY, shared by the session lifecycle, the guard and `reap` (PLAN §6.4, M0 A7).
//
// Recorded decision: GENERATION is never retried (that would spend), but teardown is cleanup, so
// `stop` + verification is retried up to 3 times with backoff. `colab stop` exits 0 even for a
// session that does not exist (A7), so its rc is no evidence: the session is released only when
// `colab sessions` no longer lists it.

import { Colab } from "./colab.ts";

export const DEFAULT_BACKOFF_MS = [10_000, 30_000, 60_000];

/** COLAB_COMFY_BACKOFF_MS: one number (all gaps) or a comma list; tests use small values. */
export function backoffFromEnv(env: Record<string, string | undefined>): number[] {
  const raw = env.COLAB_COMFY_BACKOFF_MS;
  if (!raw) return DEFAULT_BACKOFF_MS;
  const nums = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  if (nums.length === 0) return DEFAULT_BACKOFF_MS;
  return [0, 1, 2].map((i) => nums[Math.min(i, nums.length - 1)]!);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface StopOutcome {
  /** At least one `stop` call returned (rc 0, or "not found"). Informational only. */
  stopped: boolean;
  /** `colab sessions` does not list the session. The only real evidence. */
  verified: boolean;
  attempts: number;
  notes: string[];
}

/**
 * stop -> sessions, up to 3 attempts; backoff[i] between attempts, and backoff[2] before one last
 * look after the third attempt (a stop can take a moment to propagate). Never throws.
 */
export async function stopAndVerify(colab: Colab, name: string, backoffMs: number[] = DEFAULT_BACKOFF_MS, log: (m: string) => void = () => {}): Promise<StopOutcome> {
  const out: StopOutcome = { stopped: false, verified: false, attempts: 0, notes: [] };
  const listed = async (): Promise<boolean | undefined> => {
    try {
      return (await colab.sessions()).some((s) => s.name === name);
    } catch (err) {
      out.notes.push(`sessions check failed: ${(err as Error).message.split("\n")[0]}`);
      return undefined; // unknown: not evidence of release
    }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    out.attempts = attempt;
    try {
      const r = await colab.stop(name);
      if (r.ok || r.notFound) out.stopped = true;
      else out.notes.push(`stop attempt ${attempt} failed (${r.timedOut ? "timeout" : `rc ${r.code}`})`);
    } catch (err) {
      out.notes.push(`stop attempt ${attempt} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    if ((await listed()) === false) {
      out.verified = true;
      return out;
    }
    log(`stop attempt ${attempt}: session ${name} still listed or unverified`);
    await sleep(backoffMs[attempt - 1] ?? 0);
  }
  if ((await listed()) === false) out.verified = true;
  return out;
}
