// ffmpeg vocabulary shared by normalize and compose: codec names, number
// formatting, and the "effective" output geometry (draft vs. final).

import type { Output } from "../types.ts";

export interface Geometry {
  width: number;
  height: number;
  fps: number;
  pixelFormat: string;
  sampleRate: number;
  channels: 1 | 2;
  background: string;
  fit: "contain" | "cover";
}

export function geometryFor(out: Output, draft: boolean): Geometry {
  let { width, height } = out.video;
  if (draft && width > 480) {
    const scale = 480 / width;
    width = 480;
    height = Math.max(16, Math.round((out.video.height * scale) / 2) * 2);
  }
  return {
    width,
    height,
    fps: out.video.fps,
    pixelFormat: out.video.pixelFormat,
    sampleRate: out.audio.sampleRate,
    channels: out.audio.channels,
    background: out.background,
    fit: out.fit,
  };
}

export function channelLayout(channels: 1 | 2): string {
  return channels === 1 ? "mono" : "stereo";
}

/** Deterministic number formatting: up to 3 decimals, no trailing zeros. */
export function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Encoder flags for the final output (spec §1.6). */
export function outputCodecArgs(out: Output, draft: boolean): string[] {
  const q = draft ? 30 : out.video.quality;
  const v: string[] = [];
  switch (out.video.codec) {
    case "h264":
      v.push("-c:v", "libx264", "-preset", draft ? "ultrafast" : "medium", "-crf", String(q));
      break;
    case "hevc":
      v.push("-c:v", "libx265", "-preset", draft ? "ultrafast" : "medium", "-crf", String(q));
      if (out.container === "mp4" || out.container === "mov") v.push("-tag:v", "hvc1");
      break;
    case "vp9":
      v.push("-c:v", "libvpx-vp9", "-crf", String(Math.min(q, 63)), "-b:v", "0", "-row-mt", "1");
      if (draft) v.push("-deadline", "realtime", "-cpu-used", "8");
      break;
    case "av1":
      v.push("-c:v", "libsvtav1", "-crf", String(Math.min(q, 63)), "-preset", draft ? "12" : "8");
      break;
    case "prores":
      v.push("-c:v", "prores_ks", "-profile:v", "3");
      break;
  }
  const a: string[] = [];
  switch (out.audio.codec) {
    case "aac":
      a.push("-c:a", "aac", "-b:a", out.audio.bitrate);
      break;
    case "opus":
      a.push("-c:a", "libopus", "-b:a", out.audio.bitrate);
      break;
    case "pcm_s16le":
      a.push("-c:a", "pcm_s16le");
      break;
    case "flac":
      a.push("-c:a", "flac");
      break;
  }
  const extra: string[] = [];
  if (out.container === "mp4" || out.container === "mov") extra.push("-movflags", "+faststart");
  return [...v, ...a, ...extra];
}

/** What ffprobe should report for a spec-conformant output. */
export const PROBE_VIDEO_CODEC: Record<Output["video"]["codec"], string> = {
  h264: "h264",
  hevc: "hevc",
  vp9: "vp9",
  av1: "av1",
  prores: "prores",
};
export const PROBE_AUDIO_CODEC: Record<Output["audio"]["codec"], string> = {
  aac: "aac",
  opus: "opus",
  pcm_s16le: "pcm_s16le",
  flac: "flac",
};
export const PROBE_FORMAT: Record<Output["container"], string> = {
  mp4: "mov,mp4,m4a,3gp,3g2,mj2",
  mov: "mov,mp4,m4a,3gp,3g2,mj2",
  mkv: "matroska,webm",
  webm: "matroska,webm",
};

export function subtitleCodecFor(container: Output["container"]): string {
  switch (container) {
    case "mp4":
    case "mov":
      return "mov_text";
    case "mkv":
      return "srt";
    case "webm":
      return "webvtt";
  }
}

/** One ffmpeg invocation as recorded in compose.filtergraph.txt. */
export interface FfmpegStep {
  title: string;
  /** argv without the filter script itself; `-filter_complex_script` points at it. */
  argv: string[];
  filterComplex: string;
}

export function renderSteps(header: string[], steps: FfmpegStep[]): string {
  const lines: string[] = ["# filmkit compose plan (generated; same film + same produces => identical text)", ...header.map((h) => `# ${h}`), ""];
  for (const s of steps) {
    lines.push(`## ${s.title}`, `argv: ${s.argv.map(shellQuote).join(" ")}`, "filter_complex:", ...s.filterComplex.split(";").map((f) => `  ${f.trim()};`), "");
  }
  return lines.join("\n");
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
