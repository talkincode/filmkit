// Job model: node params -> a validated Job (PLAN §5.3 "Offline validation").
// normalizeJob() is purely syntactic (types, enums); validateJob() adds the
// checks that need the template and the filesystem. Both are offline and free.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "./canonical.ts";
import { ColabComfyError, EXIT, invalid, type Detail } from "./errors.ts";
import { framesFor, type BindInput, type ResolvedAudio, type ResolvedInputs, type ResolvedRef, type Template, variantFor } from "./workflow.ts";

/** Must equal the `resolution` enum in profiles/colab-comfy.yaml (guarded by test/job.test.ts). */
export const RESOLUTIONS = ["1344x768", "768x1344", "1280x704", "704x1280", "1024x768", "768x1024"] as const;
export const SPARSITIES = [0, 0.5, 0.75] as const;
export const MAX_DURATION = 6.6;
export const MAX_CANDIDATES = 4;
/** Largest shape EP03 ran on an L4 (PLAN §5.3); anything above is refused offline. */
export const PIXEL_FRAME_CAP = 704 * 1280 * 158;

export interface Job {
  node?: string;
  template: string;
  prompt: string;
  /** Film-relative paths, ref .. ref3 in order. */
  refs: string[];
  /** Film-relative WAV fed to MiniMaxH3AddGuide at frame 0 (lip-sync guide). Absent: image + prompt only. */
  audio?: string;
  seed: number;
  duration: number;
  resolution: string;
  width: number;
  height: number;
  sparsity: number;
  candidates: number;
  pick?: number;
}

type Raw = Record<string, unknown>;

/** Accept typed values (plan params) or strings (CLI flags); anything else is a problem. */
function num(raw: unknown, field: string, problems: Detail[], opts: { integer?: boolean } = {}): number | undefined {
  let v: number | undefined;
  if (typeof raw === "number") v = raw;
  else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
  if (v === undefined || !Number.isFinite(v) || (opts.integer && !Number.isInteger(v))) {
    problems.push(invalid(`${field} must be ${opts.integer ? "an integer" : "a number"}, got ${JSON.stringify(raw)}`, field));
    return undefined;
  }
  return v;
}

export function normalizeJob(raw: Raw): Job {
  const problems: Detail[] = [];
  const str = (k: string, required: boolean): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === "") {
      if (required) problems.push(invalid(`${k} is required`, k));
      return undefined;
    }
    if (typeof v !== "string") {
      problems.push(invalid(`${k} must be a string`, k));
      return undefined;
    }
    return v;
  };
  const template = str("template", true);
  const prompt = str("prompt", true);
  const refs = [str("ref", true), str("ref2", false), str("ref3", false)];
  if (refs[1] === undefined && refs[2] !== undefined) problems.push(invalid("ref3 given without ref2", "ref3"));
  const audio = str("audio", false);
  const seed = raw.seed === undefined ? (problems.push(invalid("seed is required", "seed")), undefined) : num(raw.seed, "seed", problems, { integer: true });
  if (seed !== undefined && (seed < 0 || seed > Number.MAX_SAFE_INTEGER)) problems.push(invalid("seed must be in 0..9007199254740991", "seed"));
  const duration =
    raw.duration === undefined ? (problems.push(invalid("duration is required", "duration")), undefined) : num(raw.duration, "duration", problems);
  if (duration !== undefined && (duration <= 0 || duration > MAX_DURATION)) problems.push(invalid(`duration must be > 0 and <= ${MAX_DURATION}`, "duration"));
  const resolution = str("resolution", true);
  let width = 0;
  let height = 0;
  if (resolution !== undefined) {
    if (!(RESOLUTIONS as readonly string[]).includes(resolution)) {
      problems.push(invalid(`resolution must be one of ${RESOLUTIONS.join(", ")}`, "resolution"));
    } else {
      [width, height] = resolution.split("x").map(Number) as [number, number];
    }
  }
  const sparsity = raw.sparsity === undefined ? 0 : num(raw.sparsity, "sparsity", problems);
  if (sparsity !== undefined && !(SPARSITIES as readonly number[]).includes(sparsity)) {
    problems.push(invalid(`sparsity must be one of ${SPARSITIES.join(", ")}`, "sparsity"));
  }
  const candidates = raw.candidates === undefined ? 1 : num(raw.candidates, "candidates", problems, { integer: true });
  if (candidates !== undefined && (candidates < 1 || candidates > MAX_CANDIDATES)) problems.push(invalid(`candidates must be in 1..${MAX_CANDIDATES}`, "candidates"));
  const pick = raw.pick === undefined ? undefined : num(raw.pick, "pick", problems, { integer: true });
  if (pick !== undefined && pick < 0) problems.push(invalid("pick must be >= 0", "pick"));

  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  return {
    ...(typeof raw.node === "string" && raw.node ? { node: raw.node } : {}),
    template: template!,
    prompt: prompt!,
    refs: refs.filter((r): r is string => r !== undefined),
    ...(audio !== undefined ? { audio } : {}),
    seed: seed!,
    duration: duration!,
    resolution: resolution!,
    width,
    height,
    sparsity: sparsity!,
    candidates: candidates!,
    ...(pick !== undefined ? { pick } : {}),
  };
}

/** PNG / JPEG / WebP by magic bytes; undefined for anything else. */
export function sniffImage(head: Uint8Array): ResolvedRef["ext"] | undefined {
  const at = (i: number, bytes: number[]): boolean => bytes.every((b, j) => head[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return undefined;
}

function readHead(path: string, n = 12): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(n);
    readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Existence + magic-byte check for one ref; returns a problem or the file kind. */
function checkRef(baseDir: string, ref: string, field: string): Detail | ResolvedRef["ext"] {
  const abs = resolve(baseDir, ref);
  if (!existsSync(abs) || !statSync(abs).isFile()) return invalid(`${field} file not found: ${ref}`, field);
  const kind = sniffImage(readHead(abs));
  if (!kind) return invalid(`${field} is not a PNG/JPEG/WebP image (magic bytes): ${ref}`, field);
  return kind;
}

/**
 * Duration of a RIFF/WAVE file from its header (data chunk bytes / fmt byte rate); undefined when the
 * bytes are not a WAV filmkit can read. Only the header is parsed: no audio is decoded or processed.
 */
export function wavDurationSec(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= bytes.length) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      // 0xFFFFFFFF / overlong: a streamed header; the data runs to the end of the file.
      dataBytes = Math.min(size, bytes.length - (at + 8));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes === undefined) return undefined;
  return dataBytes / byteRate;
}

/** Existence + WAV header check for the audio guide; returns a problem or the duration in seconds. */
function checkAudio(baseDir: string, audio: string): Detail | number {
  const abs = resolve(baseDir, audio);
  if (!existsSync(abs) || !statSync(abs).isFile()) return invalid(`audio file not found: ${audio}`, "audio");
  const sec = wavDurationSec(readFileSync(abs));
  if (sec === undefined) return invalid(`audio is not a readable RIFF/WAVE file (header): ${audio}`, "audio", "export the voice-over segment as .wav");
  if (!(sec > 0)) return invalid(`audio has no samples: ${audio}`, "audio");
  return sec;
}

/** Content-hash refs and audio for binding / cache keys. Throws with the same messages validateJob reports. */
export function resolveInputs(job: Job, baseDir: string): ResolvedInputs {
  const problems: Detail[] = [];
  const refs: ResolvedRef[] = [];
  job.refs.forEach((path, i) => {
    const field = i === 0 ? "ref" : `ref${i + 1}`;
    const kind = checkRef(baseDir, path, field);
    if (typeof kind !== "string") return void problems.push(kind);
    refs.push({ path, sha256: sha256Hex(readFileSync(resolve(baseDir, path))), ext: kind });
  });
  let audio: ResolvedAudio | undefined;
  if (job.audio !== undefined) {
    const sec = checkAudio(baseDir, job.audio);
    if (typeof sec !== "number") problems.push(sec);
    else audio = { path: job.audio, sha256: sha256Hex(readFileSync(resolve(baseDir, job.audio))), ext: "wav", durationSec: sec };
  }
  if (problems.length) throw new ColabComfyError(EXIT.invalidInput, problems);
  return audio ? { refs, audio } : { refs };
}

export function jobFrames(job: Job, tpl: Template): number {
  return framesFor(job.duration, tpl.bindings.fps, tpl.objectInfo.classes.MiniMaxH3ReferenceToVideo.inputs.length);
}

export function bindInput(job: Job, tpl: Template): BindInput {
  return { prompt: job.prompt, width: job.width, height: job.height, frames: jobFrames(job, tpl), seed: job.seed, sparsity: job.sparsity };
}

/** Warm-time key used by the estimate: `dense`, `vsa-0.75`, ... */
export function variantKey(job: Job): string {
  return variantFor(job.sparsity) === "dense" ? "dense" : `vsa-${job.sparsity}`;
}

export interface ValidateContext {
  baseDir: string;
  tpl: Template;
  out?: string;
  record?: string;
}

/** Offline checks (PLAN §5.3). A missing `pick` is NOT an error: plan must work before candidates exist. */
export function validateJob(job: Job, ctx: ValidateContext): Detail[] {
  const problems: Detail[] = [];
  const { tpl } = ctx;

  job.refs.forEach((path, i) => {
    const field = i === 0 ? "ref" : `ref${i + 1}`;
    const r = checkRef(ctx.baseDir, path, field);
    if (typeof r !== "string") problems.push(r);
  });
  if (job.refs.length > tpl.bindings.refs.max) problems.push(invalid(`at most ${tpl.bindings.refs.max} refs`, "ref"));

  for (const m of job.prompt.matchAll(/<Picture\s+(\d+)>/g)) {
    const k = Number(m[1]);
    if (k < 1 || k > job.refs.length) {
      problems.push(invalid(`prompt mentions <Picture ${k}> but only ${job.refs.length} ref(s) are given`, "prompt"));
    }
  }

  if (job.audio !== undefined && !tpl.bindings.audioGuide) {
    problems.push(invalid(`template ${tpl.name} has no audio guide`, "audio", "use template h3-ref2va@2 (same models, plus the MiniMaxH3AddGuide lip-sync guide)"));
  } else if (job.audio !== undefined) {
    const sec = checkAudio(ctx.baseDir, job.audio);
    if (typeof sec !== "number") problems.push(sec);
    else {
      // MiniMaxH3AddGuide crops audio that runs past the clip: the end of the line would silently lose its guide.
      const clipSec = jobFrames(job, tpl) / tpl.bindings.fps;
      if (sec > clipSec + 1e-3) {
        problems.push(
          invalid(
            `audio is ${sec.toFixed(3)}s but the clip is ${jobFrames(job, tpl)} frames (${clipSec.toFixed(3)}s); the guide would be cropped`,
            "audio",
            "raise duration to cover the audio, or cut the audio to the clip",
          ),
        );
      }
    }
  }

  if (job.pick !== undefined && job.pick >= job.candidates) {
    problems.push(invalid(`pick ${job.pick} must be < candidates ${job.candidates}`, "pick"));
  }
  if (job.seed + job.candidates - 1 > Number.MAX_SAFE_INTEGER) {
    problems.push(invalid("seed + candidates - 1 exceeds 9007199254740991", "seed"));
  }

  const { length, width, height } = tpl.objectInfo.classes.MiniMaxH3ReferenceToVideo.inputs;
  const frames = jobFrames(job, tpl);
  if (frames > length.max) problems.push(invalid(`${frames} frames exceed the node maximum ${length.max}`, "duration"));
  for (const [name, v, spec] of [["width", job.width, width], ["height", job.height, height]] as const) {
    if (v < spec.min || v % spec.step !== 0) problems.push(invalid(`${name} ${v} must be a multiple of ${spec.step} and >= ${spec.min}`, "resolution"));
  }
  if (job.width * job.height * frames > PIXEL_FRAME_CAP) {
    problems.push(
      invalid(
        `${job.width}x${job.height}x${frames} frames exceeds the largest shape known to fit an L4 (704x1280x158)`,
        "resolution",
        "lower the resolution or the duration",
      ),
    );
  }

  if (ctx.out !== undefined && !ctx.out.endsWith(".mp4")) problems.push(invalid(`--out must end in .mp4, got ${ctx.out}`, "out"));
  if (ctx.record !== undefined && !ctx.record.endsWith(".json")) problems.push(invalid(`--record must end in .json, got ${ctx.record}`, "record"));
  return problems;
}
