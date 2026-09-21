// `filmkit doctor`: is the environment able to build this project?
// Reports presence only — never prints an environment variable's value.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec, isOnPath } from "./exec.ts";
import type { LoadedFilm } from "./film.ts";
import { BUILTIN_PROFILE_NAMES } from "./profile.ts";

export interface DoctorReport {
  ok: boolean;
  ffmpeg: { found: boolean; version?: string; filters: Record<string, boolean> };
  ffprobe: { found: boolean };
  builtinProfiles: string[];
  profiles: {
    name: string;
    version: string;
    runtime: string;
    origin: string;
    binaries: { name: string; found: boolean }[];
    env: { name: string; set: boolean }[];
    healthcheck?: { argv: string[]; ok: boolean; exit: number | null; expect?: { path: string; equals: unknown; ok: boolean } };
    ok: boolean;
  }[];
  problems: string[];
}

const REQUIRED_FILTERS = ["xfade", "acrossfade", "concat", "amix", "tpad", "apad", "overlay", "adelay", "afade"];

export function doctor(loaded: LoadedFilm | undefined, cwd: string): DoctorReport {
  const problems: string[] = [];
  const ffmpegFound = isOnPath("ffmpeg");
  const ffprobeFound = isOnPath("ffprobe");
  const filters: Record<string, boolean> = {};
  let version: string | undefined;
  if (ffmpegFound) {
    const v = exec(["ffmpeg", "-version"], { cwd });
    version = /ffmpeg version (\S+)/.exec(v.stdout)?.[1];
    const f = exec(["ffmpeg", "-hide_banner", "-filters"], { cwd }).stdout;
    for (const name of REQUIRED_FILTERS) {
      filters[name] = new RegExp(`\\s${name}\\s`).test(f);
      if (!filters[name]) problems.push(`ffmpeg is missing the "${name}" filter`);
    }
  } else problems.push("ffmpeg not found on PATH");
  if (!ffprobeFound) problems.push("ffprobe not found on PATH");

  const profiles: DoctorReport["profiles"] = [];
  for (const p of loaded?.profiles.values() ?? []) {
    const rt = p.profile.runtime;
    const binaries = [...(rt.binary ? [rt.binary] : []), ...(rt.requires?.binaries ?? [])].map((name) => ({ name, found: isOnPath(name) }));
    const env = (rt.requires?.env ?? []).map((name) => ({ name, set: process.env[name] !== undefined && process.env[name] !== "" }));
    let healthcheck: DoctorReport["profiles"][number]["healthcheck"];
    // A tool installed inside a project directory (a Remotion project's node_modules)
    // only answers from there, so the Profile can pin the healthcheck's cwd.
    const hcCwd = rt.healthcheckCwd ? resolve(cwd, rt.healthcheckCwd) : cwd;
    if (rt.healthcheckCwd && !existsSync(hcCwd)) {
      problems.push(`profile ${p.profile.metadata.name}: healthcheck cwd ${rt.healthcheckCwd} does not exist`);
    } else if (rt.healthcheck && binaries.every((b) => b.found)) {
      try {
        const r = exec(rt.healthcheck, { cwd: hcCwd });
        healthcheck = { argv: rt.healthcheck, ok: r.status === 0, exit: r.status };
        if (rt.healthcheckExpect && r.status === 0) {
          const expect = { path: rt.healthcheckExpect.path, equals: rt.healthcheckExpect.equals, ok: false };
          const reason = checkJsonExpectation(r.stdout, rt.healthcheckExpect);
          expect.ok = reason === undefined;
          healthcheck.expect = expect;
          if (reason !== undefined) {
            // The command worked; what it reported is unusable. Report both.
            problems.push(`profile ${p.profile.metadata.name}: healthcheck output does not satisfy healthcheckExpect (${reason})`);
          }
        }
      } catch {
        healthcheck = { argv: rt.healthcheck, ok: false, exit: null };
      }
    }
    const ok =
      binaries.every((b) => b.found) &&
      env.every((e) => e.set) &&
      (healthcheck?.ok ?? true) &&
      (healthcheck?.expect?.ok ?? true) &&
      (!rt.healthcheckCwd || existsSync(hcCwd));
    if (!ok) {
      const why = [
        ...binaries.filter((b) => !b.found).map((b) => `binary ${b.name} not found`),
        ...env.filter((e) => !e.set).map((e) => `env ${e.name} not set`),
        ...(healthcheck && !healthcheck.ok ? [`healthcheck exited ${healthcheck.exit}`] : []),
      ];
      problems.push(`profile ${p.profile.metadata.name}: ${why.join(", ")}`);
    }
    profiles.push({ name: p.profile.metadata.name, version: p.profile.metadata.version, runtime: rt.type, origin: p.origin, binaries, env, healthcheck, ok });
  }
  return {
    ok: problems.length === 0,
    ffmpeg: { found: ffmpegFound, version, filters },
    ffprobe: { found: ffprobeFound },
    builtinProfiles: BUILTIN_PROFILE_NAMES,
    profiles,
    problems,
  };
}

/**
 * Evaluate `healthcheckExpect` against a healthcheck's stdout. Returns a reason
 * string when the expectation fails, undefined when it holds. A tool that exits
 * 0 while reporting "nothing configured" (`imagine models --json`) or while
 * always exiting 0 (`hyperframes doctor --json`) needs this.
 */
export function checkJsonExpectation(stdout: string, expect: { path: string; equals: unknown }): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "healthcheck did not print JSON";
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const wanted = JSON.stringify(expect.equals);
  const seen: unknown[] = [];
  for (const candidate of candidates) {
    let value: unknown = candidate;
    for (const key of expect.path.split(".")) {
      if (value && typeof value === "object" && key in (value as Record<string, unknown>)) value = (value as Record<string, unknown>)[key];
      else {
        value = undefined;
        break;
      }
    }
    if (JSON.stringify(value) === wanted) return undefined;
    seen.push(value);
  }
  const sample = [...new Set(seen.map((v) => JSON.stringify(v)))].slice(0, 3).join(", ");
  return `no element has ${expect.path} = ${wanted}${seen.length ? ` (saw ${sample})` : ""}`;
}

export function formatDoctor(r: DoctorReport): string {
  const mark = (b: boolean) => (b ? "✓" : "✗");
  const lines = [
    `${mark(r.ffmpeg.found)} ffmpeg ${r.ffmpeg.version ?? "(not found)"}`,
    ...Object.entries(r.ffmpeg.filters).map(([f, ok]) => `    ${mark(ok)} filter ${f}`),
    `${mark(r.ffprobe.found)} ffprobe`,
    `builtin profiles: ${r.builtinProfiles.join(", ")}`,
  ];
  for (const p of r.profiles) {
    lines.push(`${mark(p.ok)} profile ${p.name}@${p.version} (${p.runtime}, ${p.origin})`);
    for (const b of p.binaries) lines.push(`    ${mark(b.found)} binary ${b.name}`);
    for (const e of p.env) lines.push(`    ${mark(e.set)} env ${e.name} ${e.set ? "set" : "not set"}`);
    if (p.healthcheck) {
      lines.push(`    ${mark(p.healthcheck.ok)} healthcheck exit ${p.healthcheck.exit}`);
      if (p.healthcheck.expect) {
        lines.push(`    ${mark(p.healthcheck.expect.ok)} expects ${p.healthcheck.expect.path} = ${JSON.stringify(p.healthcheck.expect.equals)}`);
      }
    }
  }
  lines.push(r.ok && r.problems.length === 0 ? "everything needed for build is present" : `problems: ${r.problems.length}`);
  return lines.join("\n");
}
