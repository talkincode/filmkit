// Shared helpers for colab-comfy tests: temp dirs, fake image files, a Job factory.
// No network, no `colab`, no money: everything here is local and deterministic.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeJob, resolveInputs, type Job } from "../src/job.ts";
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
/** @1 + the audioGuide binding (lip sync). */
export const tpl2: Template = loadTemplate("h3-ref2va@2");

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
  return resolveInputs(job, dir).refs;
}

/**
 * A real PCM RIFF/WAVE file (16-bit, `rate` Hz, `channels`) of `seconds` of samples; `tag` makes the bytes unique.
 * Same shape as the EP04 VO segments (24 kHz mono s16le).
 */
export function fakeWav(seconds: number, tag = "", rate = 24000, channels = 1): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  Buffer.from(tag).copy(data); // a few non-silent bytes; enough to change the hash
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); // byte rate
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** h3-fl2va@1: FL2VA first frame + driving audio (李律 EP01 / 微辣 EP03 pipeline). */
export const tplF: Template = loadTemplate("h3-fl2va@1");

/** A PNG header with a real IHDR (width x height): enough for the magic-byte and aspect checks. */
export function fakePngSized(width: number, height: number, tag = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  return Buffer.concat([PNG_MAGIC, ihdr, Buffer.from(tag)]);
}

export const FL2VA_JOB = {
  node: "s01a",
  template: "h3-fl2va@1",
  prompt: "<竖屏中景>首帧里同一位女性正面看着镜头，用普通话说话，口型与配音同步。",
  image: "./kf/s01a.png",
  audio: "./vo/s01a.wav",
  seed: 20261019,
  duration: 3.86,
  resolution: "768x1024",
} as const;

export function makeFl2vaJob(over: Record<string, unknown> = {}): Job {
  return normalizeJob({ ...FL2VA_JOB, ...over });
}
