// Stage 2 of build: join the normalized clips along the timeline, mix overlay
// tracks in, and encode the final output (spec §2.5–2.6).

import type { Analysis } from "../project.ts";
import type { AudioDuck, AudioTrack, OverlayTrack } from "../types.ts";
import type { ClipPlan } from "./normalize.ts";
import { channelLayout, num, outputCodecArgs, subtitleCodecFor, type FfmpegStep, type Geometry } from "./ffmpeg.ts";

interface Segment {
  path: string;
  duration: number;
  /** Incoming crossfade seconds; 0 = cut. */
  xfade: number;
}

export interface ComposePlan {
  step: FfmpegStep;
  /** Where ffmpeg writes before the atomic move. */
  tmpOutput: string;
  finalOutput: string;
  total: number;
}

export function planCompose(
  a: Analysis,
  geo: Geometry,
  clips: ClipPlan[],
  opts: { draft: boolean; subtitlePath?: string; embedSubtitles: boolean; burnSubtitlesPath?: string; chaptersPath?: string },
): ComposePlan {
  const { film } = a.loaded;
  const segments: Segment[] = [];
  for (const c of clips) {
    if (c.gap) segments.push({ path: c.gap.path, duration: c.gap.duration, xfade: 0 });
    const t = c.scene.transition.type === "crossfade" && !c.gap ? c.scene.transition.duration! : 0;
    segments.push({ path: c.path, duration: c.scene.duration, xfade: segments.length === 0 ? 0 : t });
  }

  const inputs: string[][] = segments.map((s) => ["-i", s.path]);
  const filters: string[] = [];

  // ---- main track: pairwise concat / xfade ----
  let curV = "[0:v]";
  let curA = "[0:a]";
  let length = segments[0]!.duration;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const nextV = `[${i}:v]`;
    const nextA = `[${i}:a]`;
    const outV = `[mv${i}]`;
    const outA = `[ma${i}]`;
    if (seg.xfade > 0) {
      filters.push(`${curV}${nextV}xfade=transition=fade:duration=${num(seg.xfade)}:offset=${num(length - seg.xfade)}${outV}`);
      filters.push(`${curA}${nextA}acrossfade=d=${num(seg.xfade)}:c1=tri:c2=tri${outA}`);
      length = length + seg.duration - seg.xfade;
    } else {
      filters.push(`${curV}${curA}${nextV}${nextA}concat=n=2:v=1:a=1${outV}${outA}`);
      length += seg.duration;
    }
    curV = outV;
    curA = outA;
  }
  const total = Math.round(length * 1000) / 1000;

  // ---- overlay tracks ----
  const layout = channelLayout(geo.channels);
  const audioMixes: string[] = [];
  // Tracks that duck under the narration: their chain ends at [trkN] above, then
  // a sidechain compressor keyed on the main mix rewrites them to [trkdN] below.
  const ducked: { ti: number; duck: AudioDuck }[] = [];
  film.timeline.tracks.forEach((tr, ti) => {
    if (tr.kind === "audio") {
      const t = tr as AudioTrack;
      const asset = film.assets[t.asset]!;
      const path = "uri" in asset ? asset.uri : asset.produces.audio!;
      const to = t.to === "end" ? total : t.to;
      const span = Math.round((to - t.from) * 1000) / 1000;
      const inOpts = t.fit === "loop" ? ["-stream_loop", "-1", "-i", path] : ["-i", path];
      inputs.push(inOpts);
      const idx = inputs.length - 1;
      const chain = [
        `aresample=${geo.sampleRate}`,
        `aformat=sample_fmts=fltp:channel_layouts=${layout}`,
        "apad",
        `atrim=duration=${num(span)}`,
        "asetpts=PTS-STARTPTS",
      ];
      if (t.volume !== 1) chain.push(`volume=${num(t.volume)}`);
      if (t.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(t.fadeIn)}`);
      if (t.fadeOut > 0) chain.push(`afade=t=out:st=${num(span - t.fadeOut)}:d=${num(t.fadeOut)}`);
      if (t.from > 0) chain.push(`adelay=${Math.round(t.from * 1000)}:all=1`);
      const label = `[trk${ti}]`;
      filters.push(`[${idx}:a]${chain.join(",")}${label}`);
      if (t.duck && t.duck.amount > 0) {
        ducked.push({ ti, duck: t.duck });
        audioMixes.push(`[trkd${ti}]`);
      } else {
        audioMixes.push(label);
      }
    } else if (tr.kind === "overlay") {
      const o = tr as OverlayTrack;
      const asset = film.assets[o.asset]!;
      const path = "uri" in asset ? asset.uri : asset.produces.image!;
      inputs.push(["-loop", "1", "-framerate", num(geo.fps), "-i", path]);
      const idx = inputs.length - 1;
      const chain = ["format=rgba"];
      if (o.width) chain.push(`scale=${draftScale(o.width, geo, a)}:-1:flags=bicubic`);
      if (o.opacity !== 1) chain.push(`colorchannelmixer=aa=${num(o.opacity)}`);
      const label = `[ov${ti}]`;
      filters.push(`[${idx}:v]${chain.join(",")}${label}`);
      const to = o.to === "end" ? total : o.to;
      const m = draftScale(o.margin, geo, a);
      const xy: Record<OverlayTrack["position"], string> = {
        "top-left": `${m}:${m}`,
        "top-right": `main_w-overlay_w-${m}:${m}`,
        "bottom-left": `${m}:main_h-overlay_h-${m}`,
        "bottom-right": `main_w-overlay_w-${m}:main_h-overlay_h-${m}`,
        center: "(main_w-overlay_w)/2:(main_h-overlay_h)/2",
      };
      const outV = `[ovd${ti}]`;
      filters.push(`${curV}${label}overlay=${xy[o.position]}:shortest=1:enable='between(t\\,${num(o.from)}\\,${num(to)})'${outV}`);
      curV = outV;
    }
  });
  // ---- narration ducking (spec §2.6): one sidechain compressor per ducked
  // ---- track, keyed on the main mix. `amount` is the wet/dry mix: 0 means the
  // ---- filter is skipped entirely, 1 means fully ducked whenever narration speaks.
  if (ducked.length > 0) {
    const sidechains = ducked.map((_, d) => `[sc${d}]`);
    filters.push(`${curA}asplit=${ducked.length + 1}[curA_mix]${sidechains.join("")}`);
    ducked.forEach(({ ti, duck }, d) => {
      const threshold = duck.threshold ?? 0.02;
      const attackMs = (duck.attack ?? 0.02) * 1000;
      const releaseMs = (duck.release ?? 0.25) * 1000;
      filters.push(`[trk${ti}]${sidechains[d]}sidechaincompress=threshold=${num(threshold)}:ratio=20:attack=${num(attackMs)}:release=${num(releaseMs)}:mix=${num(duck.amount)}[trkd${ti}]`);
    });
    curA = "[curA_mix]";
  }
  if (audioMixes.length > 0) {
    filters.push(`${curA}${audioMixes.join("")}amix=inputs=${audioMixes.length + 1}:duration=first:normalize=0[mixa]`);
    curA = "[mixa]";
  }
  // ---- burned subtitles (spec §5): the merged sidecar file rendered into the
  // ---- picture, above overlays. The SRT is also written to disk for review.
  if (opts.burnSubtitlesPath) {
    filters.push(`${curV}subtitles=${escapeSubtitlesPath(opts.burnSubtitlesPath)}[burnv]`);
    curV = "[burnv]";
  }
  filters.push(`${curV}format=${geo.pixelFormat}[outv]`);
  filters.push(`${curA}aformat=sample_fmts=fltp:channel_layouts=${layout}[outa]`);

  // ---- output ----
  const out = film.output;
  const finalOutput = opts.draft ? out.path.replace(/\.([a-z0-9]+)$/, `.draft.$1`) : out.path;
  const tmpOutput = `build/.tmp/${finalOutput.split("/").pop()}`;
  const argv = ["ffmpeg", "-hide_banner", "-y", "-nostdin", ...inputs.flat()];
  const maps = ["-map", "[outv]", "-map", "[outa]"];
  if (opts.chaptersPath) {
    argv.push("-i", opts.chaptersPath);
    maps.push("-map_chapters", String(inputs.length));
  }
  if (opts.embedSubtitles && opts.subtitlePath) {
    argv.push("-i", opts.subtitlePath);
    maps.push("-map", `${inputs.length + (opts.chaptersPath ? 1 : 0)}:s`, "-c:s", subtitleCodecFor(out.container));
  }
  argv.push(
    "-filter_complex", filters.join(";\n"),
    ...maps,
    ...outputCodecArgs(out, opts.draft),
    "-pix_fmt", geo.pixelFormat,
    "-r", num(geo.fps),
    "-ar", String(geo.sampleRate),
    "-ac", String(geo.channels),
    "-t", num(total),
    "-f", ffmpegFormat(out.container),
    tmpOutput,
  );
  return { step: { title: "compose", argv, filterComplex: filters.join(";\n") }, tmpOutput, finalOutput, total };
}

function ffmpegFormat(container: string): string {
  return container === "mkv" ? "matroska" : container;
}

/** Quote an SRT path for the `subtitles` video filter: single-quote the whole
 *  thing and escape backslash, quote and colon (the filter option separator). */
export function escapeSubtitlesPath(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:")}'`;
}

/** Pixel sizes in the film are for the full-size output; scale them for drafts. */
function draftScale(px: number, geo: Geometry, a: Analysis): number {
  const full = a.loaded.film.output.video.width;
  if (geo.width === full) return px;
  return Math.max(1, Math.round((px * geo.width) / full));
}
