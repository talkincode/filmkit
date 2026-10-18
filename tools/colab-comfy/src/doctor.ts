// `colab-comfy doctor [--json]` (the Profile's healthcheck): { ready, checks[] }. Read-only and free: it runs
// `colab version` and `colab sessions` (the auth probe) and never opens a session.
// Added in M6 because the filmkit-level E2E (E9: `filmkit doctor`) needs it; M7 documents it.

import { delimiter, join } from "node:path";
import { accessSync, constants } from "node:fs";
import { Colab } from "./colab.ts";
import { OURS_PREFIX } from "./reap.ts";
import { loadTemplate } from "./workflow.ts";

export interface Check {
  name: string;
  ok: boolean;
  message: string;
  /** A warning does not make the report not-ready. */
  warning?: boolean;
}

export interface DoctorReport {
  ready: boolean;
  checks: Check[];
}

function onPath(bin: string, env: Record<string, string | undefined>): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export async function doctor(env: Record<string, string | undefined>): Promise<DoctorReport> {
  const checks: Check[] = [];
  const colabFound = onPath("colab", env);
  checks.push({ name: "colab-on-path", ok: colabFound, message: colabFound ? "colab found on PATH" : "colab not found on PATH (install the colab CLI)" });

  if (colabFound) {
    const colab = new Colab({ env });
    try {
      checks.push({ name: "colab-version", ok: true, message: `colab ${await colab.version()}` });
    } catch (err) {
      checks.push({ name: "colab-version", ok: false, message: `colab version failed: ${(err as Error).message.split("\n")[0]}` });
    }
    try {
      const sessions = await colab.sessions();
      checks.push({ name: "colab-auth", ok: true, message: `authenticated (--auth ${env.COLAB_COMFY_AUTH ?? "adc"}); ${sessions.length} active session(s)` });
      const leftovers = sessions.filter((s) => s.name.startsWith(OURS_PREFIX));
      if (leftovers.length) {
        checks.push({ name: "leftover-sessions", ok: true, warning: true, message: `${leftovers.map((s) => s.name).join(", ")} still active: run \`colab-comfy reap\`` });
      }
    } catch (err) {
      checks.push({ name: "colab-auth", ok: false, message: `colab sessions failed (auth?): ${(err as Error).message.split("\n")[0]}` });
    }
  }

  try {
    loadTemplate("h3-ref2va@1");
    checks.push({ name: "templates", ok: true, message: "template h3-ref2va@1 present and consistent" });
  } catch (err) {
    checks.push({ name: "templates", ok: false, message: (err as Error).message });
  }
  return { ready: checks.every((c) => c.ok), checks };
}

export function formatDoctor(r: DoctorReport): string {
  return [`ready: ${r.ready}`, ...r.checks.map((c) => `  ${c.ok ? (c.warning ? "warn" : "ok  ") : "FAIL"} ${c.name}: ${c.message}`)].join("\n");
}
