// TypeScript shapes for the documents in docs/spec.md. These mirror the JSON
// Schemas in ./schema/*.json; the schemas are the source of truth for
// validation, these types are for code that runs after validation.

export const API_VERSION = "filmkit/v1alpha1";

export type ProduceType = "video" | "image" | "audio" | "subtitle" | "file";
export type AssetKind = "image" | "video" | "audio" | "subtitle" | "font" | "file";
export type RuntimeType = "none" | "cli" | "skill" | "mcp" | "http";
export type ExitClass = "ok" | "io" | "invalid-input" | "missing-dependency" | "tool-failure";

/** Order used to pick a node's primary produce (spec §1.7.3). */
export const PRODUCE_PRIORITY: ProduceType[] = ["video", "image", "audio", "subtitle", "file"];

export type Produces = Partial<Record<ProduceType, string>>;

export interface Impl {
  profile: string;
  task: string;
  params: Record<string, unknown>;
}

export interface Transition {
  type: "cut" | "crossfade";
  duration?: number;
}

export interface Intent {
  description?: string;
  action?: string;
  caption?: string;
  narration?: { text?: string; voiceRef?: string };
  references?: string[];
}

export interface Scene {
  id: string;
  duration?: number;
  durationPolicy: "auto" | "exact" | "min";
  start?: number;
  transition?: Transition;
  intent?: Intent;
  inputs: string[];
  impl: Impl;
  produces: Produces;
  audioMode?: "replace" | "mix" | "keep";
}

export interface StaticAsset {
  kind: AssetKind;
  uri: string;
  license?: string;
}

export interface GeneratedAsset {
  kind: AssetKind;
  impl: Impl;
  produces: Produces;
  inputs: string[];
}

export type Asset = StaticAsset | GeneratedAsset;

export function isGeneratedAsset(a: Asset): a is GeneratedAsset {
  return "impl" in a;
}

export interface Output {
  path: string;
  container: "mp4" | "mov" | "mkv" | "webm";
  video: {
    width: number;
    height: number;
    fps: number;
    codec: "h264" | "hevc" | "vp9" | "av1" | "prores";
    pixelFormat: string;
    quality: number;
  };
  audio: {
    codec: "aac" | "opus" | "pcm_s16le" | "flac";
    sampleRate: 44100 | 48000 | 96000;
    channels: 1 | 2;
    bitrate: string;
  };
  duration: { planned?: number; tolerance: number };
  fit: "contain" | "cover";
  background: string;
}

export interface AudioTrack {
  id: string;
  kind: "audio";
  asset: string;
  from: number;
  to: number | "end";
  fit: "loop" | "trim" | "exact";
  /**
   * Path of a `filmkit/cues-v1` file (segment boundaries of the audio). Required
   * for `fit: exact`, ignored otherwise. filmkit never derives it from a tool's
   * own timing document; the agent writes it.
   */
  cues?: string;
  /** Alignment tolerance for `fit: exact`, seconds (default 0.05). */
  tolerance?: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  stems?: unknown;
}

export interface SubtitlesTrack {
  id: string;
  kind: "subtitles";
  source: "scenes";
  mode: "sidecar" | "embed" | "burn";
}

export interface OverlayTrack {
  id: string;
  kind: "overlay";
  asset: string;
  from: number;
  to: number | "end";
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  margin: number;
  width?: number;
  opacity: number;
}

export type Track = AudioTrack | SubtitlesTrack | OverlayTrack;

export interface Timeline {
  sequence: string[];
  transition: { default: Transition };
  tracks: Track[];
}

export interface Film {
  apiVersion: typeof API_VERSION;
  kind: "Film";
  metadata: {
    name: string;
    title?: string;
    description?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, unknown>;
  };
  vars: Record<string, string | number | boolean>;
  profiles: { ref: string; source?: string }[];
  assets: Record<string, Asset>;
  output: Output;
  scenes: Scene[];
  timeline: Timeline;
}

export interface ProfileTask {
  description?: string;
  /**
   * Working directory for this task's commands. A template (film-dir-relative
   * unless it uses `${film.dir}`). Declaring it also makes file placeholders
   * absolute, because the tool no longer runs in the film directory (spec §3.4).
   */
  cwd?: string;
  paramsSchema: Record<string, unknown>;
  produces?: ProduceType[];
  validate?: string[];
  invocation?: string[];
}

export interface Profile {
  apiVersion: typeof API_VERSION;
  kind: "Profile";
  metadata: { name: string; version: string; description?: string };
  runtime: {
    type: RuntimeType;
    binary?: string;
    skill?: string;
    requires?: { env?: string[]; binaries?: string[] };
    healthcheck?: string[];
    /** Working directory for the healthcheck, film-dir-relative (spec §3.1). */
    healthcheckCwd?: string;
    exitCodes?: Record<string, ExitClass>;
  };
  capabilities?: { produces?: ProduceType[]; consumes?: ProduceType[] };
  tasks: Record<string, ProfileTask>;
}

/** Media facts as reported by ffprobe (spec §4). */
export interface Probe {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  format?: string;
}

export type NodeStatus = "ready" | "missing" | "stale" | "partial";

export interface LockNode {
  kind: "scene" | "asset";
  status: NodeStatus;
  profile: { name: string; version: string };
  task: string;
  paramsHash: string;
  produces: Partial<Record<ProduceType, { path: string; sha256?: string; probe?: Probe }>>;
}

export interface LockTimelineScene {
  id: string;
  start: number;
  end: number;
  duration: number;
  estimated: boolean;
}

export interface Lock {
  apiVersion: typeof API_VERSION;
  kind: "Lock";
  film: { path: string; sha256: string };
  nodes: Record<string, LockNode>;
  timeline: { total: number; scenes: LockTimelineScene[] };
  build?: {
    /** sha256 of filmkit.yaml when this build ran; status compares it to detect an outdated build. */
    filmSha256: string;
    output: { path: string; sha256: string; probe?: Probe };
    filtergraph: { path: string; sha256: string };
    ffmpeg: { version: string };
    draft: boolean;
  };
}
