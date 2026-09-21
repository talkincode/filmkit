// Stage 1 of build: turn each placed scene into an intermediate clip with the
// output geometry and exactly the derived duration (spec §2.2–2.4).

import type { Analysis } from "../project.ts";
import type { PlacedScene } from "../timeline.ts";
import { hasAlpha } from "../probe.ts";
import { channelLayout, num, type FfmpegStep, type Geometry } from "./ffmpeg.ts";

export interface ClipPlan {
  scene: PlacedScene;
  /** Relative path of the intermediate clip. */
  path: string;
  step: FfmpegStep;
  /** Background gap inserted before the scene (explicit start), if any. */
  gap?: { path: string; duration: number; step: FfmpegStep };
}

const CLIP_DIR = "build/clips";

export function planClips(a: Analysis, geo: Geometry): ClipPlan[] {
  return a.timeline.scenes.map((p) => planClip(a, p, geo));
}

function planClip(a: Analysis, p: PlacedScene, geo: Geometry): ClipPlan {
  const { scene, duration: d } = p;
  const state = a.state.nodes.get(scene.id)!;
  const path = `${CLIP_DIR}/${scene.id}.mkv`;
  const inputs: string[][] = []; // per-input option groups ending in "-i <path>"
  const filters: string[] = [];

  // ---- video source ----
  /** Input index that carries the scene's own picture (video, or a still image). */
  let videoInput = -1;
  // Set for every picture source except the translucent-image branch, which
  // builds its own overlay chain and never uses `vsrc`.
  let vsrc = "";
  const videoProbe = state.produces.video?.probe;
  const imageProbe = state.produces.image?.probe;
  // A picture with an alpha channel is composited onto the film's background
  // instead of being padded: otherwise its transparent areas (a text card, a
  // logo) would flatten to black and `output.background` would be ignored.
  const translucentImage = !scene.produces.video && hasAlpha(imageProbe);
  if (scene.produces.video) {
    inputs.push(["-i", scene.produces.video]);
    videoInput = inputs.length - 1;
    vsrc = `[${videoInput}:v]`;
  } else if (translucentImage) {
    inputs.push(["-f", "lavfi", "-i", `color=c=${geo.background}:s=${geo.width}x${geo.height}:r=${num(geo.fps)}`]);
    const bg = `[${inputs.length - 1}:v]`;
    inputs.push(["-loop", "1", "-framerate", num(geo.fps), "-i", scene.produces.image!]);
    videoInput = inputs.length - 1;
    const fg = `[${videoInput}:v]`;
    const fit = geo.fit === "contain"
      ? `scale=${geo.width}:${geo.height}:force_original_aspect_ratio=decrease:flags=bicubic`
      : `scale=${geo.width}:${geo.height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${geo.width}:${geo.height}`;
    const place = geo.fit === "contain" ? "(W-w)/2:(H-h)/2" : "0:0";
    filters.push(`${fg}fps=${num(geo.fps)},${fit},setsar=1,format=rgba[fg]`);
    filters.push(`${bg}format=rgba[bgc]`);
    filters.push(`[bgc][fg]overlay=${place}:format=auto,trim=duration=${num(d)},setpts=PTS-STARTPTS[v]`);
  } else {
    inputs.push(["-loop", "1", "-framerate", num(geo.fps), "-i", scene.produces.image!]);
    videoInput = inputs.length - 1;
    vsrc = `[${videoInput}:v]`;
  }
  if (!translucentImage) {
    const scaleChain =
      geo.fit === "contain"
        ? `scale=${geo.width}:${geo.height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${geo.width}:${geo.height}:(ow-iw)/2:(oh-ih)/2:color=${geo.background}`
        : `scale=${geo.width}:${geo.height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${geo.width}:${geo.height}`;
    const vchain = [`fps=${num(geo.fps)}`, scaleChain, "setsar=1", `format=${geo.pixelFormat}`];
    if (scene.produces.video) {
      const vdur = videoProbe?.duration ?? d;
      if (vdur < d) vchain.push(`tpad=stop_mode=clone:stop_duration=${num(d - vdur)}`);
    }
    vchain.push(`trim=duration=${num(d)}`, "setpts=PTS-STARTPTS");
    filters.push(`${vsrc}${vchain.join(",")}[v]`);
  }

  // ---- audio source (spec §2.3) ----
  const mode = scene.audioMode ?? (scene.produces.audio ? "replace" : "keep");
  const videoHasAudio = Boolean(videoProbe?.hasAudio);
  const layout = channelLayout(geo.channels);
  const conform = `aresample=${geo.sampleRate},aformat=sample_fmts=fltp:channel_layouts=${layout}`;
  const fit = `apad,atrim=duration=${num(d)},asetpts=PTS-STARTPTS`;
  const sources: string[] = [];
  if ((mode === "replace" || mode === "mix") && scene.produces.audio) {
    inputs.push(["-i", scene.produces.audio]);
    sources.push(`[${inputs.length - 1}:a]`);
  }
  if ((mode === "keep" || mode === "mix") && scene.produces.video && videoHasAudio) {
    sources.push(`[${videoInput}:a]`);
  }
  if (sources.length === 0) {
    inputs.push(["-f", "lavfi", "-i", `anullsrc=r=${geo.sampleRate}:cl=${layout}`]);
    filters.push(`[${inputs.length - 1}:a]${conform},${fit}[a]`);
  } else if (sources.length === 1) {
    filters.push(`${sources[0]}${conform},${fit}[a]`);
  } else {
    sources.forEach((s, i) => filters.push(`${s}${conform}[m${i}]`));
    filters.push(`${sources.map((_, i) => `[m${i}]`).join("")}amix=inputs=${sources.length}:duration=longest:normalize=0,${fit}[a]`);
  }

  const argv = [
    "ffmpeg", "-hide_banner", "-y", "-nostdin",
    ...inputs.flat(),
    "-filter_complex_script", `${CLIP_DIR}/${scene.id}.filter`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", geo.pixelFormat, "-r", num(geo.fps),
    "-c:a", "pcm_s16le", "-ar", String(geo.sampleRate), "-ac", String(geo.channels),
    path,
  ];
  const plan: ClipPlan = { scene: p, path, step: { title: `clip ${scene.id}`, argv, filterComplex: filters.join(";\n") } };

  if (p.gapBefore > 0) {
    const gapPath = `${CLIP_DIR}/${scene.id}.gap.mkv`;
    const gapFilters = [
      `[0:v]format=${geo.pixelFormat},trim=duration=${num(p.gapBefore)},setpts=PTS-STARTPTS[v]`,
      `[1:a]${conform},atrim=duration=${num(p.gapBefore)},asetpts=PTS-STARTPTS[a]`,
    ];
    plan.gap = {
      path: gapPath,
      duration: p.gapBefore,
      step: {
        title: `gap before ${scene.id}`,
        argv: [
          "ffmpeg", "-hide_banner", "-y", "-nostdin",
          "-f", "lavfi", "-i", `color=c=${geo.background}:s=${geo.width}x${geo.height}:r=${num(geo.fps)}`,
          "-f", "lavfi", "-i", `anullsrc=r=${geo.sampleRate}:cl=${layout}`,
          "-filter_complex_script", `${CLIP_DIR}/${scene.id}.gap.filter`,
          "-map", "[v]", "-map", "[a]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", geo.pixelFormat, "-r", num(geo.fps),
          "-c:a", "pcm_s16le", "-ar", String(geo.sampleRate), "-ac", String(geo.channels),
          gapPath,
        ],
        filterComplex: gapFilters.join(";\n"),
      },
    };
  }
  return plan;
}
