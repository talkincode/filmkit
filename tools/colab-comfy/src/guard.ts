// The detached guardian (`colab-comfy guard`, PLAN §6.4, D12 layer 2). It covers what `finally` cannot:
// SIGKILL of the helper, a crashed host, filmkit killed without the signal reaching its child.
//
// Every tick (COLAB_COMFY_GUARD_TICK_MS, default 15 s):
//   * active.json gone, or it records another session  -> the helper closed normally: exit 0
//   * parent pid dead, or now > deadline + 300 s       -> stop + verify, clear active.json, exit
// Its lifetime is bounded: it gives up at deadline + 600 s even if the parent is still alive.

import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Colab, type ColabOptions } from "./colab.ts";
import { EXIT } from "./errors.ts";
import { appendLedger, pidAlive, readActive, removeActive } from "./ledger.ts";
import { backoffFromEnv, sleep, stopAndVerify } from "./teardown.ts";

export const GUARD_GRACE_SEC = 300;
export const GUARD_MAX_LIFETIME_SEC = 600;

export interface GuardOptions {
  session: string;
  parentPid: number;
  /** Epoch seconds. */
  deadline: number;
  /** `<film dir>/.colab-comfy` */
  stateDir: string;
  env: Record<string, string | undefined>;
  colabOptions?: ColabOptions;
  log?: (m: string) => void;
}

export interface GuardResult {
  exitCode: number;
  reason: "closed" | "parent-dead" | "past-deadline" | "lifetime-exceeded";
  stopVerified?: boolean;
}

export async function runGuard(o: GuardOptions): Promise<GuardResult> {
  const log = o.log ?? (() => {});
  const tickMs = Number(o.env.COLAB_COMFY_GUARD_TICK_MS ?? 15_000);
  const backoff = backoffFromEnv(o.env);
  for (;;) {
    const active = readActive(o.stateDir);
    if (!active || active.name !== o.session) return { exitCode: EXIT.ok, reason: "closed" };
    const now = Date.now() / 1000;
    const parentDead = !pidAlive(o.parentPid);
    const pastDeadline = now > o.deadline + GUARD_GRACE_SEC;
    if (parentDead || pastDeadline) {
      const reason = parentDead ? "parent-dead" : "past-deadline";
      log(`guard: ${reason}; stopping ${o.session}`);
      const colab = new Colab({ ...o.colabOptions, env: o.env });
      const r = await stopAndVerify(colab, o.session, backoff, log);
      appendLedger(o.stateDir, {
        session: o.session,
        outcome: r.verified ? "guard-stopped" : "guard-leak",
        guardReason: reason,
        stopVerified: r.verified,
        endedAt: new Date().toISOString(),
      });
      if (r.verified) removeActive(o.stateDir, o.session);
      else log(`SESSION_LEAK: guard could not release ${o.session}; run colab-comfy reap`);
      return { exitCode: r.verified ? EXIT.ok : EXIT.toolFailure, reason, stopVerified: r.verified };
    }
    if (now > o.deadline + GUARD_MAX_LIFETIME_SEC) return { exitCode: EXIT.ok, reason: "lifetime-exceeded" };
    await sleep(tickMs);
  }
}

export interface SpawnGuardOptions {
  session: string;
  parentPid: number;
  deadline: number;
  stateDir: string;
  env: Record<string, string | undefined>;
}

/** Start `colab-comfy guard` detached from this process group; returns its pid. Output goes to guard-<name>.log. */
export function spawnGuard(o: SpawnGuardOptions): number {
  mkdirSync(o.stateDir, { recursive: true });
  const logFd = openSync(join(o.stateDir, `guard-${o.session}.log`), "a");
  try {
    const cli = join(import.meta.dir, "..", "bin", "colab-comfy.ts");
    const proc = Bun.spawn(
      [process.execPath, cli, "guard", "--session", o.session, "--parent-pid", String(o.parentPid), "--deadline", String(o.deadline), "--state", o.stateDir],
      { env: o.env as Record<string, string>, stdin: "ignore", stdout: logFd, stderr: logFd, detached: true },
    );
    proc.unref();
    return proc.pid;
  } finally {
    closeSync(logFd);
  }
}
