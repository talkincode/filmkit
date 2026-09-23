// `filmkit import hyperstory <schema.json>`: one-way conversion of a Hyperstory
// Video Composition Schema into a filmkit Film (docs/roadmap.md, direction
// "让现有 skill 消费 filmkit 格式"). The importer is deliberately lossy about
// fields filmkit has no concept for: it reports them instead of inventing
// tool parameters (AGENTS.md: filmkit does not understand tool semantics).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { FilmkitError, io, invalid } from "./errors.ts";
import { loadFilm } from "./film.ts";
import { loadYamlFile } from "./yaml.ts";

export interface ImportResult {
  out: string;
  scenes: number;
  assets: number;
  /** Input fields that were mapped into metadata.annotations instead of a first-class field. */
  annotations: Record<string, unknown>;
  /** Input fields filmkit cannot express; the agent must decide what to do with them. */
  warnings: string[];
  /** Files the imported film references that do not exist yet (the asset plan). */
  missingFiles: string[];
}

interface HyperstorySchema {
  version?: string;
  title?: string;
  duration?: number;
  cover?: string;
  coverDuration?: number;
  render?: { width?: number; height?: number; fps?: number };
  defaults?: Record<string, unknown>;
  audio?: {
    bgmId?: string;
    bgm?: string;
    voiceMap?: Record<string, string>;
  };
  scenes?: HyperstoryScene[];
}

interface HyperstoryScene {
  id?: string;
  start?: number;
  duration?: number;
  image?: string;
  video?: string;
  videoPrompt?: string;
  videoAudio?: { enabled?: boolean; volume?: number };
  voice?: string;
  subtitle?: string;
  voiceRef?: string;
  voiceInstruct?: string;
  voiceSpeed?: number;
  voiceText?: string;
  caption?: string;
  description?: string;
  action?: string;
}

export function importHyperstory(schemaPath: string, outPath: string, opts: { force?: boolean } = {}): ImportResult {
  if (!existsSync(schemaPath)) throw new FilmkitError(io(`file not found: ${schemaPath}`));
  if (existsSync(outPath) && !opts.force) {
    throw new FilmkitError(
      io(`refusing to overwrite ${outPath}`, { hint: "pass --force if you really want to replace it (the existing film is not read first)" }),
    );
  }
  const src = loadYamlFile(schemaPath);
  const input = src.value as HyperstorySchema;
  const errors = [];
  if (input === null || typeof input !== "object") errors.push(invalid(`${schemaPath}: not an object`));
  else if (!Array.isArray(input.scenes) || input.scenes.length === 0) errors.push(invalid(`${schemaPath}: scenes must be a non-empty array`, { field: "scenes" }));
  if (errors.length) throw new FilmkitError(errors);

  const warnings: string[] = [];
  const annotations: Record<string, unknown> = { "hyperstory.version": input.version ?? "1.0" };
  if (typeof input.duration === "number") {
    // Hyperstory's `duration` is a plan, not a contract: scene media decides the
    // real total. Keep it as a note instead of turning it into output.duration.planned.
    annotations["hyperstory.plannedDuration"] = input.duration;
    warnings.push(`duration: ${input.duration}s is a plan, not a constraint; it is kept in metadata.annotations and the real total comes from the produced media`);
  }
  for (const [k, v] of Object.entries(input.defaults ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "imageFit" || k === "bgmVolume" || k === "bgmFadeOutDuration") continue; // mapped below
    annotations[`hyperstory.defaults.${k}`] = v;
    warnings.push(`defaults.${k} has no filmkit equivalent; kept in metadata.annotations["hyperstory.defaults.${k}"] as a hint for the agent`);
  }

  const name = slug(basename(schemaPath, extname(schemaPath)));
  const assets: string[] = [];
  const assetNames = new Map<string, string>(); // uri -> asset name, so equal files share one asset
  const assetName = (uri: string, kind: string, wanted: string): string => {
    const existing = assetNames.get(uri);
    if (existing) return existing;
    let candidate = slug(wanted);
    for (let n = 2; assets.some((a) => a.startsWith(`  ${candidate}:`)); n++) candidate = `${slug(wanted)}-${n}`;
    assetNames.set(uri, candidate);
    assets.push(`  ${candidate}: { kind: ${kind}, uri: ${yamlStr(uri)} }`);
    return candidate;
  };

  // ---- global audio ----
  let bgmAsset: string | undefined;
  if (input.audio?.bgm) bgmAsset = assetName(input.audio.bgm, "audio", "bgm");
  const voiceAssets = new Map<string, string>();
  for (const [key, uri] of Object.entries(input.audio?.voiceMap ?? {})) {
    if (!uri) continue;
    voiceAssets.set(key, assetName(uri, "audio", key === "default" ? "voice-default" : `voice-${key}`));
  }

  const scenes: string[] = [];
  const videoPromptScenes: Record<string, string> = {};
  input.scenes!.forEach((s, i) => {
    const id = slug(s.id ?? `scene-${String(i + 1).padStart(2, "0")}`);
    const hasImage = Boolean(s.image);
    const hasVideo = Boolean(s.video);
    const hasVoice = Boolean(s.voice);
    if (!hasImage && !hasVideo) {
      throw new FilmkitError(invalid(`${schemaPath}: scenes[${i}] (${id}) has neither image nor video`, { field: `scenes[${i}]` }));
    }
    const duration = typeof s.duration === "number" && s.duration > 0 ? s.duration : undefined;
    if (duration === undefined) {
      throw new FilmkitError(invalid(`${schemaPath}: scenes[${i}] (${id}) has no usable duration`, { field: `scenes[${i}].duration` }));
    }
    // Narration decides the floor (hyperstory: "合成时不得短于该场景实际旁白音频时长"),
    // a clip decides its own length, an image needs an explicit one.
    const policy = hasVoice || hasVideo ? (hasVoice ? "min" : "auto") : "exact";

    const produces: string[] = [];
    if (hasVideo) produces.push(`video: ${yamlStr(s.video!)}`);
    else produces.push(`image: ${yamlStr(s.image!)}`);
    if (hasVoice) produces.push(`audio: ${yamlStr(s.voice!)}`);
    if (s.subtitle) produces.push(`subtitle: ${yamlStr(s.subtitle)}`);

    const intent: string[] = [];
    if (s.description) intent.push(`description: ${yamlStr(s.description)}`);
    if (s.action) intent.push(`action: ${yamlStr(s.action)}`);
    if (s.caption) intent.push(`caption: ${yamlStr(s.caption)}`);
    const narration: string[] = [];
    if (s.voiceText || s.caption) narration.push(`text: ${yamlStr(s.voiceText ?? s.caption ?? "")}`);
    const voiceRef = voiceAssets.get(s.voiceRef ?? "default");
    if (voiceRef) narration.push(`voiceRef: ${voiceRef}`);
    else if (hasVoice) warnings.push(`scenes[${i}] (${id}) has a voice file but no voiceRef in audio.voiceMap; no voice asset was created`);
    if (narration.length) intent.push(`narration: { ${narration.join(", ")} }`);

    const body: string[] = [`  - id: ${id}`, `    duration: ${duration}`, `    durationPolicy: ${policy}`];
    if (intent.length) body.push(`    intent:`, ...intent.map((line) => `      ${line}`));
    body.push(`    impl: { profile: filmkit/static, task: clip }`);
    body.push(`    produces: { ${produces.join(", ")} }`);
    if (hasVideo) {
      const va = s.videoAudio;
      if (va?.enabled === false) body.splice(body.length - 1, 0, `    audioMode: replace`);
      if (va?.enabled === false) warnings.push(`scenes[${i}] (${id}) videoAudio.enabled=false -> audioMode: replace (scene audio becomes silence unless a voice file is produced)`);
      if (typeof va?.volume === "number" && va.volume !== 1) warnings.push(`scenes[${i}] (${id}) videoAudio.volume=${va.volume} is not expressible per scene; set it with the tool that produces the clip or in a timeline track`);
    }
    if (s.videoPrompt) {
      videoPromptScenes[id] = s.videoPrompt;
      warnings.push(`scenes[${i}] (${id}) is a generated video: point impl at a video-generation Profile and feed it videoPrompt (kept in metadata.annotations["hyperstory.videoPrompt.${id}"])`);
    }
    if (s.voiceSpeed !== undefined && s.voiceSpeed !== 1) warnings.push(`scenes[${i}] (${id}) voiceSpeed=${s.voiceSpeed} belongs to the voice tool; set it when producing the narration`);
    if (s.voiceInstruct) warnings.push(`scenes[${i}] (${id}) voiceInstruct belongs to the voice tool; kept in metadata.annotations`);
    if (s.voiceInstruct) annotations[`hyperstory.voiceInstruct.${id}`] = s.voiceInstruct;
    scenes.push(body.join("\n"));
  });

  // ---- cover card ----
  // A cover becomes an ordinary first scene: the file is an input of nothing, so it
  // shows up in `plan` as a node with an unplaced produce, next to every other card.
  const coverDuration = input.coverDuration ?? 3;
  if (input.cover && coverDuration > 0) {
    scenes.unshift(`  - id: cover
    duration: ${coverDuration}
    durationPolicy: exact
    intent: { description: "cover card" }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ${yamlStr(input.cover)} }`);
  }

  const render = input.render ?? {};
  const tracks: string[] = [];
  if (bgmAsset) {
    const volume = typeof input.defaults?.bgmVolume === "number" ? input.defaults.bgmVolume : 0.15;
    const fadeOut = typeof input.defaults?.bgmFadeOutDuration === "number" ? input.defaults.bgmFadeOutDuration : 3;
    tracks.push(`    - { id: music, kind: audio, asset: ${bgmAsset}, fit: loop, volume: ${volume}, fadeOut: ${fadeOut} }`);
  }
  if (input.scenes!.some((s) => s.subtitle)) tracks.push(`    - { id: subs, kind: subtitles, source: scenes, mode: sidecar }`);

  const fit = input.defaults?.imageFit === "cover" ? "cover" : "contain";
  const annotationLines = Object.entries({ ...annotations, ...videoPromptScenesToAnnotations(videoPromptScenes) }).map(
    ([k, v]) => `    ${yamlStr(k)}: ${JSON.stringify(v)}`,
  );
  const yaml = `# Generated by \`filmkit import hyperstory ${schemaPath}\`. Edit freely: filmkit never
# reads a Hyperstory schema again, and never writes this file back to one.
apiVersion: filmkit/v1alpha1
kind: Film
metadata:
  name: ${slug(name)}
  title: ${yamlStr(input.title ?? name)}
${annotationLines.length ? `  annotations:\n${annotationLines.join("\n")}\n` : ""}profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
assets:
${assets.length ? assets.join("\n") : "  {}"}
output:
  container: mp4
  video: { width: ${render.width ?? 1920}, height: ${render.height ?? 1080}, fps: ${render.fps ?? 30}, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
  fit: ${fit}
${tracks.length ? `timeline:\n  tracks:\n${tracks.join("\n")}\n` : ""}scenes:
${scenes.join("\n")}
`;

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, yaml, "utf8");
  } catch (err) {
    throw new FilmkitError(io(`cannot write ${outPath}: ${(err as Error).message}`));
  }
  // Prove the result is a legal film (schema + structure) before reporting success.
  loadFilm(outPath);

  const missing = [...assetNames.keys()];
  return { out: outPath, scenes: scenes.length, assets: assets.length, annotations, warnings, missingFiles: missing };
}

function videoPromptScenesToAnnotations(prompts: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, prompt] of Object.entries(prompts)) out[`hyperstory.videoPrompt.${id}`] = prompt;
  return out;
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return out === "" ? "item" : /^[a-z0-9]/.test(out) ? out : `x-${out}`;
}

export function yamlStr(s: string): string {
  return JSON.stringify(s);
}
