// Shared helpers for colab-comfy tests: temp dirs, fake image files, a Job factory.
// No network, no `colab`, no money: everything here is local and deterministic.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeJob, resolveRefs, type Job } from "../src/job.ts";
import { loadTemplate, type ResolvedRef, type Template } from "../src/workflow.ts";

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function tmpProject(): { dir: string; cleanup: () => void; write: (rel: string, data: string | Uint8Array) => string } {
  const dir = mkdtempSync(join(tmpdir(), "colab-comfy-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    write(rel, data) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      return full;
    },
  };
}

/** A file that passes the PNG magic-byte check; `tag` makes the content (and hash) unique. */
export function fakePng(tag: string): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(tag)]);
}

export const tpl: Template = loadTemplate("h3-ref2va@1");

export const BASE_JOB = {
  node: "s1a",
  template: "h3-ref2va@1",
  prompt: "The woman from <Picture 1> talks to the camera.",
  ref: "./refs/a.png",
  seed: 20261017,
  duration: 4.05,
  resolution: "704x1280",
} as const;

export function makeJob(over: Record<string, unknown> = {}): Job {
  return normalizeJob({ ...BASE_JOB, ...over });
}

/** Project with refs a/b/c.png already written; returns refs resolved for `job`. */
export function refsFor(dir: string, job: Job): ResolvedRef[] {
  return resolveRefs(job, dir);
}
