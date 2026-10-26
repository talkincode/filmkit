// ffmpeg/ffprobe, used the way filmkit uses them: the only video tools. blockout
// never touches pixels itself; it encodes a PNG sequence and measures the result.

import { readFileSync } from "node:fs";
import { fail, io, missingDependency, toolFailure } from "./errors.ts";
import { run, RunError, runOk } from "./exec.ts";

export async function ffmpegVersion(): Promise<string> {
  try {
    const r = await run(["ffmpeg", "-version"]);
    const m = /ffmpeg version (\S+)/.exec(r.stdout);
    if (r.status === 0 && m) return m[1]!;
  } catch (err) {
    if (!(err instanceof RunError)) throw err;
  }
  return fail(missingDependency("ffmpeg is not installed or not on PATH", { hint: "ffmpeg and ffprobe are filmkit's own dependency: install them first (e.g. brew install ffmpeg)" }));
}

export interface Encode {
  /** printf-style input pattern, e.g. /tmp/x/f_%04d.png */
  pattern: string;
  startNumber: number;
  fps: number;
  frames: number;
  out: string;
  crf?: number;
}

/**
 * PNG sequence -> H.264. Fixed flags, bitexact, no metadata: the same frames give the
 * same file on the same ffmpeg. BT.709 limited range is tagged, so players agree on color.
 */
export async function encodeVideo(e: Encode): Promise<void> {
  await runOk(
    [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(e.fps), "-start_number", String(e.startNumber), "-i", e.pattern,
      "-frames:v", String(e.frames),
      "-vf", "format=rgb24,scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", String(e.crf ?? 18), "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-r", String(e.fps), "-an", "-movflags", "+faststart",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
      e.out,
    ],
    "ffmpeg encode",
  );
}

export interface VideoFacts {
  width: number;
  height: number;
  fps: number;
  /** Decoded frame count (ffprobe -count_frames), not the container's claim. */
  frames: number;
  durationSeconds: number;
  codec: string;
  pixelFormat: string;
}

export async function probeVideo(path: string): Promise<VideoFacts> {
  const r = await runOk(
    ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-print_format", "json", "-show_streams", "-show_format", path],
    "ffprobe",
  );
  const j = JSON.parse(r.stdout) as { streams?: Record<string, string>[]; format?: { duration?: string } };
  const s = j.streams?.[0];
  if (!s) return fail(toolFailure(`ffprobe found no video stream in ${path}`));
  const [num, den] = String(s.avg_frame_rate ?? s.r_frame_rate).split("/").map(Number);
  return {
    width: Number(s.width),
    height: Number(s.height),
    fps: den ? num! / den : Number(num),
    frames: Number(s.nb_read_frames),
    durationSeconds: Number(s.duration ?? j.format?.duration),
    codec: String(s.codec_name),
    pixelFormat: String(s.pix_fmt),
  };
}

/** Hash of the DECODED pixels: two PNGs with the same picture compare equal whatever metadata or compressor they carry. */
export async function pixelHash(path: string): Promise<string> {
  const r = await runOk(["ffmpeg", "-v", "error", "-i", path, "-f", "hash", "-hash", "sha256", "-"], `pixel hash of ${path}`);
  const m = /SHA256=([0-9a-f]{64})/.exec(r.stdout);
  if (!m) return fail(toolFailure(`could not hash ${path}`, { hint: r.stdout.trim() }));
  return m[1]!;
}

/** width/height from the PNG header, without decoding. */
export function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  if (b.length < 24 || b.toString("hex", 0, 8) !== "89504e470d0a1a0a") return fail(io(`${path} is not a PNG file`));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Every frame 0..n-1 exists and has the declared size; otherwise the render did not do what was asked. */
export function checkFrames(pathOf: (frame: number) => string, n: number, width: number, height: number, label: string): void {
  for (let f = 0; f < n; f++) {
    let size;
    try {
      size = pngSize(pathOf(f));
    } catch (err) {
      return fail(toolFailure(`${label}: frame ${f} is missing or unreadable (${n} frames expected)`, { hint: (err as Error).message }));
    }
    if (size.width !== width || size.height !== height) {
      return fail(toolFailure(`${label}: frame ${f} is ${size.width}x${size.height}, the scene declares ${width}x${height}`));
    }
  }
}
