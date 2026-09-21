// `filmkit init [dir]`: a skeleton that passes validate as-is and builds with
// nothing but ffmpeg. Refuses non-empty directories.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { FilmkitError, io } from "./errors.ts";

export const INIT_FILM = (name: string) => `apiVersion: filmkit/v1alpha1
kind: Film
metadata:
  name: ${name}
  title: ${name}
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
assets:
  # Drop a real music file here, or generate one with a profile (see docs/spec.md §1.5).
  bgm:
    kind: audio
    impl:
      profile: filmkit/ffmpeg
      task: exec
      params:
        args: ["-f", "lavfi", "-i", "sine=frequency=220:duration=12", "-ac", "2", "\${produces.audio}"]
    produces:
      audio: ./build/assets/bgm.wav
output:
  container: mp4
  video: { width: 1280, height: 720, fps: 30, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: title
    duration: 3
    intent:
      description: Title card.
    impl: { profile: filmkit/static, task: clip }
    produces:
      image: ./assets/title.png
  - id: body
    duration: 4
    transition: { type: crossfade, duration: 0.5 }
    intent:
      description: Second card. Replace produces with real footage, narration and an .srt.
    impl: { profile: filmkit/static, task: clip }
    produces:
      image: ./assets/body.png
timeline:
  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2, fadeOut: 1.5 }
`;

export function init(target: string): { dir: string; files: string[] } {
  const dir = resolve(target);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new FilmkitError(io(`refusing to initialize: ${dir} is not empty`));
  }
  mkdirSync(join(dir, "assets"), { recursive: true });
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "") || "film";
  const files = ["filmkit.yaml", "assets/title.png", "assets/body.png", ".gitignore"];
  writeFileSync(join(dir, "filmkit.yaml"), INIT_FILM(name), "utf8");
  writeFileSync(join(dir, "assets/title.png"), PNG_PLACEHOLDER);
  writeFileSync(join(dir, "assets/body.png"), PNG_PLACEHOLDER);
  writeFileSync(join(dir, ".gitignore"), "build/\n", "utf8");
  return { dir, files };
}

// A 64x36 dark-grey PNG, so `init` -> `build` works with no other tooling.
const PNG_PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAPUlEQVR42u3PQQkAQAgAMIUL4s+v/dNdC0HYGiyrJy57cZyAgICAgICAgICAgICAgICAgICAgICAgIDAtg9ACgEFDGP7SgAAAABJRU5ErkJggg==",
  "base64",
);
