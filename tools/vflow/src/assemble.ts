// Explicit final-cut import. No generation, creative selection or network writes.
// Uses ordinary Film + builtin ffmpeg nodes, never extends the core schema.
import { createHash } from "node:crypto";
import YAML from "yaml";
import type { Bundle } from "./bundle.ts";
import type { Conversion, FetchItem } from "./convert.ts";
import { fail, invalid } from "./errors.ts";

const idFor = (prefix: string, id: string) => `${prefix}-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
const seconds = (frames: number, fps: number) => frames / fps;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const extensions: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "audio/ogg": "ogg", "audio/flac": "flac", "audio/aac": "aac", "audio/webm": "webm",
};

export function convertAssembly(bundle: Bundle): Conversion {
  const comp = bundle.composition;
  const bad = (field: string, message: string): never => fail(invalid(message, { field }));
  if (!comp.sequence.length || new Set(comp.sequence).size !== comp.sequence.length)
    bad("composition.sequence", "assembly needs a non-empty sequence with unique shots");
  if (!integer(bundle.revision, 1)) bad("revision", "assembly requires a fixed exported revision");
  const fps = comp.format.fps;
  const fetch = new Map<string, FetchItem>();
  const assets: Record<string, unknown> = {};
  const tracks: unknown[] = [];
  const notes: Record<string, unknown> = {};
  const motionVideos = new Set(bundle.motions.map((motion) => motion.video));
  const file = (id: unknown, kind: "video" | "audio", field: string, targetPrefix?: string): string => {
    if (typeof id !== "string" || !id) return bad(field, `assembly requires a selected ${kind} asset`);
    const entry = bundle.assets.get(id);
    if (!entry || !entry.mimeType.startsWith(`${kind}/`)) return bad(field, `asset ${id} is missing or is not ${kind}`);
    if (kind === "video" && motionVideos.has(id)) return bad(field, "white-model reference cannot become final footage");
    const path = `${targetPrefix ?? `./assets/vflow/${entry.sha256}`}.${extensions[entry.mimeType] ?? "bin"}`;
    const item = fetch.get(id) ?? { assetId: id, sha256: entry.sha256, sizeBytes: entry.sizeBytes, mimeType: entry.mimeType, targets: [] };
    if (!item.targets.includes(path)) item.targets.push(path);
    fetch.set(id, item);
    return path;
  };
  let totalFrames = 0;
  const scenes = comp.sequence.map((shotId) => {
    const shot = comp.shots[shotId]!;
    const field = `composition.shots.${shotId}`;
    if (!integer(shot.durationFrames, 1)) bad(`${field}.durationFrames`, "assembly requires a positive integer frame duration; no estimates");
    totalFrames += shot.durationFrames!;
    const id = idFor("shot", shotId);
    const produces: Record<string, string> = {
      video: file(shot.selectedVideo, "video", `${field}.selected.video`, `./assets/${id}/video`),
    };
    if (shot.selectedAudio !== null && shot.selectedAudio !== undefined)
      produces.audio = file(shot.selectedAudio, "audio", `${field}.selected.audio`, `./assets/${id}/audio`);
    notes[id] = { shot: shotId, selectedVideo: shot.selectedVideo, ...(produces.audio ? { selectedAudio: shot.selectedAudio } : {}) };
    return {
      id, duration: seconds(shot.durationFrames!, fps), durationPolicy: "exact",
      intent: { description: shot.description },
      impl: { profile: "filmkit/static", task: "clip" }, produces,
      audioMode: produces.audio ? "replace" : "keep",
    };
  });
  if (!Number.isSafeInteger(totalFrames)) bad("composition.sequence", "total frame count exceeds safe integer range");
  const rawTracks = comp.audioTrackDefinitions ?? [];
  if (!Array.isArray(rawTracks)) bad("composition.audioTracks", "must be an array");
  const trackIds = new Set<string>();
  const trackNotes: Record<string, unknown> = {};
  for (const [index, raw] of (rawTracks as unknown[]).entries()) {
    const field = `composition.audioTracks[${index}]`;
    if (!object(raw)) bad(field, "must be an audio track");
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id || trackIds.has(t.id)) bad(`${field}.id`, "track id must be non-empty and unique");
    trackIds.add(t.id as string);
    if (!integer(t.startFrame, 0) || !integer(t.durationFrames, 1) || (t.trimStartFrame !== undefined && !integer(t.trimStartFrame, 0)))
      bad(field, "track start, duration and source offset must be valid integer frames");
    const start = t.startFrame as number, duration = t.durationFrames as number, offset = (t.trimStartFrame ?? 0) as number;
    if (start + duration > totalFrames) bad(field, "audio track exceeds the fixed composition duration");
    const input = file(t.asset, "audio", `${field}.asset`);
    const id = idFor("track", t.id as string);
    const sourceId = `${id}-source`, clipId = `${id}-clip`;
    assets[sourceId] = { kind: "audio", uri: input };
    // Source offset is NOT the timeline start. Decode/crop locally, pad short
    // audio with silence, never loop it or change the source bytes.
    assets[clipId] = {
      kind: "audio", inputs: [sourceId],
      impl: { profile: "filmkit/ffmpeg", task: "exec", params: { args: [
        "-i", input, "-vn", "-af",
        `atrim=start=${seconds(offset, fps)},asetpts=PTS-STARTPTS,apad,atrim=duration=${seconds(duration, fps)}`,
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "${produces.audio}",
      ] } },
      produces: { audio: `./build/vflow-audio/${id}.wav` },
    };
    tracks.push({ id, kind: "audio", asset: clipId, from: seconds(start, fps), to: seconds(start + duration, fps), fit: "trim", volume: 1 });
    trackNotes[id] = { id: t.id, role: t.role, asset: t.asset, startFrame: start, durationFrames: duration, trimStartFrame: offset };
  }
  const ignored = ["reference materials and unselected candidates are not assembly inputs; retained in the exported bundle", "dependsOn describes design dependencies, not a filmkit execution graph"];
  const film = {
    apiVersion: "filmkit/v1alpha1", kind: "Film",
    metadata: { name: idFor("film", comp.id), title: comp.title ?? comp.id, annotations: {
      "vflow.source": { protocol: bundle.apiVersion, project: comp.project, composition: comp.id, revision: bundle.revision, mode: "assemble" },
      "vflow.shots": notes, "vflow.audioTracks": trackNotes,
    } },
    profiles: [{ ref: "filmkit/static" }, ...(tracks.length ? [{ ref: "filmkit/ffmpeg" }] : [])],
    assets, scenes,
    output: { container: "mp4", video: { ...comp.format, codec: "h264" }, audio: { codec: "aac", sampleRate: 48000, channels: 2 } },
    timeline: { transition: { default: { type: "cut" } }, tracks },
  };
  return {
    yaml: `# Fixed-revision vflow assembly; run filmkit plan before build. No automatic generation or remote writes.\n${YAML.stringify(film, { lineWidth: 0 })}`,
    scenes: scenes.length, assets: Object.keys(assets).length, fetch: [...fetch.values()], ignored,
    warnings: ["Exact shot durations may trim long clips or freeze short clips. Selected audio replaces clip audio; otherwise clip audio is kept.", ...(tracks.length ? ["Run the planned local ffmpeg audio nodes before building; source offsets are cropped, short audio is padded with silence, never looped."] : [])],
  };
}
