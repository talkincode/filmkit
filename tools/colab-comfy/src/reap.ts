// `colab-comfy reap`: stop OUR leaked sessions, never anyone else's (PLAN §5.4, D12 layer 4).
//
// A listed session is ours only if its name starts with `fk-` AND it is the one recorded in this
// project's .colab-comfy/active.json. A recorded session whose owner pid is still alive belongs to a
// running batch and is left alone (decision: the bot's periodic sweep must not kill a live run).
// Everything else (including other `fk-*` sessions without a record) is foreign and untouched.

import { Colab, type SessionInfo } from "./colab.ts";
import { type ActiveRecord, pidAlive, readActive, removeActive } from "./ledger.ts";
import { stopAndVerify } from "./teardown.ts";

export const OURS_PREFIX = "fk-";

export type Classification = "ours-leaked" | "running" | "foreign";

export interface Classified {
  name: string;
  kind: Classification;
  reason: string;
}

/** Pure: no I/O besides the injected liveness probe. */
export function classifySessions(listed: SessionInfo[], active: ActiveRecord | null, alive: (pid: number) => boolean = pidAlive): Classified[] {
  return listed.map((s): Classified => {
    if (!s.name.startsWith(OURS_PREFIX)) return { name: s.name, kind: "foreign", reason: `name does not start with "${OURS_PREFIX}"` };
    if (!active || active.name !== s.name) return { name: s.name, kind: "foreign", reason: "not recorded in this project's .colab-comfy/active.json" };
    if (alive(active.pid)) return { name: s.name, kind: "running", reason: `owned by a running batch (pid ${active.pid})` };
    return { name: s.name, kind: "ours-leaked", reason: `recorded in active.json; owner pid ${active.pid} is dead` };
  });
}

export type ReapAction = "stopped" | "would-stop" | "running" | "foreign" | "leak";

export interface ReapReport {
  ok: boolean;
  dryRun: boolean;
  sessions: { name: string; action: ReapAction; reason: string }[];
  /** A stale active.json (its session is already gone, owner dead) was removed. */
  activeCleared: boolean;
  leaked: string[];
}

export interface ReapOptions {
  /** `<film dir>/.colab-comfy` */
  stateDir: string;
  colab: Colab;
  backoffMs: number[];
  dryRun?: boolean;
  log?: (m: string) => void;
}

export async function reap(o: ReapOptions): Promise<ReapReport> {
  const log = o.log ?? (() => {});
  const active = readActive(o.stateDir);
  const listed = await o.colab.sessions();
  const report: ReapReport = { ok: true, dryRun: !!o.dryRun, sessions: [], activeCleared: false, leaked: [] };

  for (const c of classifySessions(listed, active)) {
    if (c.kind === "foreign") {
      report.sessions.push({ name: c.name, action: "foreign", reason: c.reason });
    } else if (c.kind === "running") {
      report.sessions.push({ name: c.name, action: "running", reason: c.reason });
    } else if (o.dryRun) {
      report.sessions.push({ name: c.name, action: "would-stop", reason: c.reason });
    } else {
      log(`reap: stopping ${c.name} (${c.reason})`);
      const r = await stopAndVerify(o.colab, c.name, o.backoffMs, log);
      if (r.verified) {
        removeActive(o.stateDir, c.name);
        report.sessions.push({ name: c.name, action: "stopped", reason: c.reason });
      } else {
        report.ok = false;
        report.leaked.push(c.name);
        report.sessions.push({ name: c.name, action: "leak", reason: `still listed after ${r.attempts} stop attempts; active.json kept` });
      }
    }
  }

  // Stale record: the session is gone from the server and its owner is dead.
  if (active && !listed.some((s) => s.name === active.name) && !pidAlive(active.pid)) {
    if (!o.dryRun) {
      removeActive(o.stateDir, active.name);
      report.activeCleared = true;
    }
  }
  return report;
}

export function formatReap(r: ReapReport): string {
  if (r.sessions.length === 0 && !r.activeCleared) return "nothing to reap";
  const lines = r.sessions.map((s) => `${s.action}: ${s.name} (${s.reason})`);
  if (r.activeCleared) lines.push("cleared stale .colab-comfy/active.json");
  if (r.leaked.length) lines.push(`SESSION_LEAK: could not release ${r.leaked.join(", ")}; run \`colab stop -s <name>\` by hand`);
  return lines.join("\n");
}
