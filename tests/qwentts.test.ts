// The qwentts integration (https://github.com/talkincode/qwentts): local Qwen3-TTS
// narration. Same shape as the other narration paths — one node produces the
// audio, the scene names it with `scenes[].audio`, and `durationPolicy: min`
// follows the narration's real length.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
let stubDir: string;
let prevPath: string;

function stubQwentts(): void {
  stubDir = mkdtempSync(join(tmpdir(), "filmkit-stub-qwen-"));
  writeFileSync(
    join(stubDir, "qwen3-tts-ai"),
    `#!/bin/sh
{ echo "ARGV=$*"; } >> "$STUB_LOG"
for a in "$@"; do
  case "$a" in
    --print-models) echo "Default model: customvoice"; echo "Default CustomVoice speaker: Serena"; exit 0 ;;
    --text=) echo "qwen3-tts-ai: error: --text must not be empty" >&2; exit 2 ;;
    *NO_MODEL*) echo "Model weights not found. Pass --allow-download or pre-fetch them." >&2; exit 1 ;;
  esac
done
out=""
for a in "$@"; do case "$a" in --output=*) out="\${a#--output=}" ;; esac; done
[ -n "$out" ] || { echo "qwen3-tts-ai: error: --output is required" >&2; exit 2; }
cp "$STUB_WAV" "$out"
echo "Saved audio to: $out"
`,
    { mode: 0o755 },
  );
  prevPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${prevPath}`;
}

const qwenttsFilm = (params: string) =>
  film({
    assets: `  voice:
    kind: audio
    impl:
      profile: qwentts
      task: speak
      params: { text: "深夜的律所走廊，只有一盏灯亮着。"${params} }
    produces: { audio: ./build/voice/s1.wav }`,
    scenes: `  - id: s1
    duration: 3
    durationPolicy: min
    audio: voice
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }`,
    output: `  container: mp4
  video: { width: 320, height: 180, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/qwentts.yaml");

const log = () => readFileSync(p.path("stub.log"), "utf8").trim().split("\n").filter(Boolean);

beforeEach(() => {
  p = project();
  p.write("profiles/qwentts.yaml", readFileSync(join(import.meta.dir, "../profiles/qwentts.yaml"), "utf8"));
  media.png(p.path("assets/card.png"));
  media.wav(p.path("stub.wav"), 4.2);
  process.env.STUB_LOG = p.path("stub.log");
  process.env.STUB_WAV = p.path("stub.wav");
  writeFileSync(p.path("stub.log"), "");
  stubQwentts();
});

afterEach(() => {
  process.env.PATH = prevPath;
  for (const k of ["STUB_LOG", "STUB_WAV"]) delete process.env[k];
  rmSync(stubDir, { recursive: true, force: true });
  p.cleanup();
});

describe("qwentts profile", () => {
  test("speak produces the narration; the scene follows its length; the film builds", () => {
    p.write("filmkit.yaml", qwenttsFilm(", model: customvoice, voice: Serena, emotionIntensity: low, speed: 0.98"));
    expect(p.cli("validate").exitCode).toBe(0);

    const plan = p.json<{ nodes: { id: string; status: string; executor: string }[]; timeline: { total: number } }>("plan");
    expect(plan.out!.nodes.map((n) => `${n.id}:${n.status}`)).toEqual(["voice:missing", "s1:blocked"]);
    expect(plan.out!.nodes.find((n) => n.id === "voice")!.executor).toBe("filmkit run");

    expect(p.cli("run", "voice").exitCode).toBe(0);
    const argv = log()[0]!;
    expect(argv).toContain("--text=深夜的律所走廊，只有一盏灯亮着。");
    expect(argv).toContain("--output=./build/voice/s1.wav");
    expect(argv).toContain("--model=customvoice");
    expect(argv).toContain("--voice=Serena");
    expect(argv).toContain("--emotion-intensity=low");
    expect(argv).toContain("--speed=0.98");
    // Unset optional flags are dropped rather than passed empty.
    expect(argv).not.toContain("--instruct");
    expect(argv).not.toContain("--reference-audio");
    expect(argv).not.toContain("--allow-download");

    // The narration decides the scene length: 4.2s of speech over a 3s plan.
    const after = p.json<{ nodes: unknown[]; timeline: { total: number } }>("plan");
    expect(after.out!.nodes).toHaveLength(0);
    expect(after.out!.timeline.total).toBe(4.2);
    expect(p.cli("build").exitCode).toBe(0);
    expect(Math.abs(probe(p.path("build/t.mp4")).duration - 4.2)).toBeLessThan(0.2);
  });

  test("cloning route: base model with a reference clip, kept verbatim", () => {
    media.wav(p.path("assets/ref.mp3"), 6);
    p.write("filmkit.yaml", qwenttsFilm(", model: base, mode: quality, referenceAudio: ./assets/ref.mp3, refText: 参考音频中逐字说过的内容。"));
    const v = p.json("validate");
    expect(v.err?.errors?.map((e) => `${e.field}: ${e.message}`).join("\n")).toBeUndefined();
    expect(v.exitCode).toBe(0);
    expect(p.cli("run", "voice").exitCode).toBe(0);
    const argv = log()[0]!;
    expect(argv).toContain("--model=base");
    expect(argv).toContain("--mode=quality");
    expect(argv).toContain("--reference-audio=./assets/ref.mp3");
    expect(argv).toContain("--ref-text=参考音频中逐字说过的内容。");
  });

  test("a missing reference clip is a missing input, not a failed run", () => {
    p.write("filmkit.yaml", qwenttsFilm(", model: base, referenceAudio: ./assets/absent.mp3"));
    const plan = p.json<{ missingFiles: { path: string; usedBy: string[] }[] }>("plan");
    expect(plan.out!.missingFiles.map((m) => [m.path, m.usedBy])).toEqual([["./assets/absent.mp3", ["voice"]]]);
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/referenced file is not in place: \.\/assets\/absent\.mp3/);
  });

  test("a tool-level failure (missing weights) leaves no produce behind", () => {
    // The schema pins `model` to known aliases, so drive the tool failure
    // through a free-text param the stub reacts to.
    p.write("filmkit.yaml", qwenttsFilm(", instruct: NO_MODEL"));
    const r = p.json("run", "voice");
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.message).toMatch(/qwen3-tts-ai exited with 1/);
    expect(r.err!.errors[0]!.hint).toMatch(/Pass --allow-download or pre-fetch them/);
    expect(existsSync(p.path("build/voice/s1.wav"))).toBe(false);
  });

  test("undeclared params are refused; doctor runs the cheap healthcheck", () => {
    p.write("filmkit.yaml", qwenttsFilm(", model: customvoice, voiceStyle: warm"));
    const bad = p.json("validate");
    expect(bad.exitCode).toBe(2);
    expect(bad.err!.errors[0]!.message).toMatch(/unknown field "voiceStyle"/);

    p.write("filmkit.yaml", qwenttsFilm(", model: customvoice"));
    const doctor = p.json<{ profiles: { name: string; ok: boolean; healthcheck?: { ok: boolean } }[] }>("doctor");
    expect(doctor.exitCode).toBe(0);
    const qwentts = doctor.out!.profiles.find((x) => x.name === "qwentts")!;
    expect(qwentts.ok).toBe(true);
    expect(qwentts.healthcheck!.ok).toBe(true);
    expect(log().join("\n")).toContain("--print-models");
  });
});
