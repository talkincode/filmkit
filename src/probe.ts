// ffprobe wrapper. Returns the small, stable subset of media facts filmkit
// records in the lock file and uses for timeline derivation.

import { exec, execFailure } from "./exec.ts";
import { FilmkitError } from "./errors.ts";
import type { Probe } from "./types.ts";

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    pix_fmt?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
    disposition?: { attached_pic?: number };
  }[];
  chapters?: { time_base?: string; start?: number; end?: number; tags?: { title?: string } }[];
}

export function probeMedia(path: string, cwd: string): Probe {
  const r = exec(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", path],
    { cwd },
  );
  if (r.status !== 0) throw new FilmkitError(execFailure(r, "tool-failure", `ffprobe ${path}`));
  let json: FfprobeJson;
  try {
    json = JSON.parse(r.stdout) as FfprobeJson;
  } catch {
    throw new FilmkitError({ code: "tool-failure", message: `ffprobe ${path}: unparsable JSON output` });
  }
  const probe: Probe = { format: json.format?.format_name };
  const fmtDuration = json.format?.duration ? Number(json.format.duration) : undefined;
  if (fmtDuration !== undefined && Number.isFinite(fmtDuration)) probe.duration = round(fmtDuration);
  probe.hasVideo = false;
  probe.hasAudio = false;
  for (const s of json.streams ?? []) {
    if (s.codec_type === "video" && !s.disposition?.attached_pic) {
      probe.hasVideo = true;
      probe.width = s.width;
      probe.height = s.height;
      probe.videoCodec = s.codec_name;
      probe.pixelFormat = s.pix_fmt;
      const fps = parseRate(s.r_frame_rate) ?? parseRate(s.avg_frame_rate);
      if (fps !== undefined) probe.fps = round(fps);
    } else if (s.codec_type === "audio") {
      probe.hasAudio = true;
      probe.sampleRate = s.sample_rate ? Number(s.sample_rate) : undefined;
      probe.channels = s.channels;
      probe.audioCodec = s.codec_name;
      if (probe.duration === undefined && s.duration) probe.duration = round(Number(s.duration));
    }
  }
  if (json.chapters?.length) {
    probe.chapters = json.chapters.map((c) => {
      const [n, d] = (c.time_base ?? "1/1000").split("/").map(Number);
      const scale = n && d ? n / d : 0.001;
      return { start: round((c.start ?? 0) * scale), end: round((c.end ?? 0) * scale), title: c.tags?.title ?? "" };
    });
  }
  return probe;
}

/**
 * True for pixel formats with an alpha channel. A scene whose picture is such
 * an image is composited onto `output.background`, so a transparent text card
 * keeps the film's backdrop instead of flattening to black (spec §2.4).
 */
export function hasAlpha(p: Probe | undefined): boolean {
  return p?.pixelFormat !== undefined && ALPHA_FORMATS.test(p.pixelFormat);
}

const ALPHA_FORMATS = /^(rgba|bgra|argb|abgr|ya8|ya16|rgba64|bgra64|yuva|gbrap|pal8)/;

/** Still images report a video stream; treat them as having no duration. */
export function isStillImage(p: Probe): boolean {
  // ffprobe reports single images via the *_pipe demuxers or image2.
  return Boolean(p.hasVideo) && !p.hasAudio && (p.format?.endsWith("_pipe") || p.format?.includes("image2") || false);
}

function parseRate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const [n, d] = s.split("/").map(Number);
  if (!n || !d) return n && Number.isFinite(n) ? n : undefined;
  return n / d;
}

/** Millisecond precision keeps lock files and filtergraphs stable across ffprobe builds. */
export function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
