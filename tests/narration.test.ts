// Narration and subtitles with the tool that is already integrated: HyperFrames
// ships a local TTS, a local transcriber and an image matte. Together with the
// `subtitles.source` extension they form the chain
//   text -> narration audio -> transcription -> .srt -> composed film,
// which is what most talking-head/explainer films need.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
let stubDir: string;
let prevPath: string;

/** A stub `npx` for hyperframes' tts / transcribe / remove-background / render / check / doctor. */
function stubNpx(): void {
  stubDir = mkdtempSync(join(tmpdir(), "filmkit-stub-narr-"));
  writeFileSync(
    join(stubDir, "npx"),
    `#!/bin/sh
cmd=""
for a in "$@"; do case "$a" in tts|transcribe|remove-background|render|check|doctor) cmd="$a" ;; esac; done
[ -z "$cmd" ] && { echo "stub npx: unknown command" >&2; exit 1; }
{ echo "ARGV=$*"; } >> "$STUB_LOG"
out=""
for a in "$@"; do case "$a" in --output=*) out="\${a#--output=}" ;; esac; done
case "$cmd" in
  doctor) echo '{"ok":true,"checks":[{"name":"Chrome","ok":true}]}'; exit 0 ;;
  check) echo "check ok"; exit 0 ;;
  tts) cp "$STUB_WAV" "$out" ;;
  transcribe)
    case "$*" in
      *--to=srt*) cp "$STUB_SRT" "$out" ;;
      *) for a in "$@"; do case "$a" in --dir=*) cp "$STUB_JSON" "\${a#--dir=}/transcript.json" ;; esac; done ;;
    esac ;;
  remove-background) cp "$STUB_PNG" "$out" ;;
  render) cp "$STUB_VIDEO" "$out" ;;
esac
`,
    { mode: 0o755 },
  );
  prevPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${prevPath}`;
}

const narrationFilm = (subtitleSource: string) =>
  film({
    assets: `  bgm: { kind: audio, uri: ./bgm.wav }
  voice:
    kind: audio
    impl:
      profile: hyperframes
      task: tts
      params: { text: "深夜的律所走廊，只有一盏灯亮着。", voice: zf_xiaobei, lang: zh, speed: 0.95 }
    produces: { audio: ./build/voice/s1.wav }
  transcript:
    kind: file
    impl:
      profile: hyperframes
      task: transcribe
      params: { input: ./build/voice/s1.wav, dir: ./build/voice, language: zh, model: large-v3 }
    produces: { file: ./build/voice/transcript.json }
  captions:
    kind: subtitle
    impl:
      profile: hyperframes
      task: subtitles
      params: { transcript: ./build/voice/transcript.json }
    produces: { subtitle: ./build/voice/s1.srt }
  portrait:
    kind: image
    impl:
      profile: hyperframes
      task: matte-image
      params: { input: ./assets/portrait.png }
    produces: { image: ./build/portrait.png }`,
    scenes: `  - id: s1
    duration: 4
    durationPolicy: min
    audio: voice
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }`,
    tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2 }
    - { id: subs, kind: subtitles, source: ${subtitleSource}, mode: sidecar }
    - { id: person, kind: overlay, asset: portrait, position: bottom-right, margin: 20, width: 120, from: 0.5, to: 3.5 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/hyperframes.yaml");

const log = () => readFileSync(p.path("stub.log"), "utf8").trim().split("\n").filter(Boolean);

beforeEach(() => {
  p = project();
  p.write("profiles/hyperframes.yaml", readFileSync(join(import.meta.dir, "../profiles/hyperframes.yaml"), "utf8"));
  media.png(p.path("assets/card.png"), 320, 180, "0x102030");
  media.png(p.path("assets/portrait.png"), 80, 120, "0x804020");
  media.wav(p.path("bgm.wav"), 1, 220);
  media.wav(p.path("stub-voice.wav"), 3.5);
  media.pngAlpha(p.path("stub-matte.png"), 80, 120, { w: 40, h: 100 });
  media.mp4(p.path("stub-video.mp4"), 2, { w: 320, h: 180 });
  writeFileSync(p.path("stub.srt"), "1\n00:00:00,400 --> 00:00:01,900\n深夜的律所走廊\n\n2\n00:00:02,000 --> 00:00:09,000\n超出的字幕\n");
  process.env.STUB_LOG = p.path("stub.log");
  process.env.STUB_WAV = p.path("stub-voice.wav");
  process.env.STUB_SRT = p.path("stub.srt");
  writeFileSync(p.path("stub-transcript.json"), JSON.stringify([{ text: "深夜", start: 0.4, end: 1.9, id: "w0" }]));
  process.env.STUB_JSON = p.path("stub-transcript.json");
  process.env.STUB_PNG = p.path("stub-matte.png");
  process.env.STUB_VIDEO = p.path("stub-video.mp4");
  writeFileSync(p.path("stub.log"), "");
  stubNpx();
});

afterEach(() => {
  process.env.PATH = prevPath;
  for (const k of ["STUB_LOG", "STUB_WAV", "STUB_SRT", "STUB_JSON", "STUB_PNG", "STUB_VIDEO"]) delete process.env[k];
  rmSync(stubDir, { recursive: true, force: true });
  p.cleanup();
});

describe("narration, transcription and matting", () => {
  test("text -> narration -> transcription -> srt -> composed film", () => {
    p.write("filmkit.yaml", narrationFilm("captions"));
    const v = p.json("validate");
    expect(v.err?.errors.map((e) => `${e.field}: ${e.message}`).join("\n")).toBeUndefined();
    expect(v.exitCode).toBe(0);

    const plan = p.json<{ nodes: { id: string; status: string; executor: string }[] }>("plan");
    // The scene waits for its narration (a named audio asset), so it is blocked
    // until the tts node has run; everything else is ready to execute.
    expect(plan.out!.nodes.map((n) => `${n.id}:${n.status}`).sort()).toEqual([
      "captions:missing",
      "portrait:missing",
      "s1:blocked",
      "transcript:missing",
      "voice:missing",
    ]);
    expect(plan.out!.nodes.filter((n) => n.status !== "blocked").every((n) => n.executor === "filmkit run")).toBe(true);

    for (const id of ["voice", "transcript", "captions", "portrait"]) {
      const r = p.json("run", id);
      expect(r.err?.errors?.map((e) => `${id}: ${e.message}`).join("\n")).toBeUndefined();
      expect(r.exitCode).toBe(0);
    }
    const args = log().join("\n");
    expect(args).toContain("hyperframes tts 深夜的律所走廊，只有一盏灯亮着。 --output=./build/voice/s1.wav --voice=zf_xiaobei --lang=zh --speed=0.95");
    expect(args).toContain("hyperframes transcribe ./build/voice/s1.wav --dir=./build/voice --language=zh --model=large-v3");
    expect(args).toContain("hyperframes transcribe ./build/voice/transcript.json --to=srt --output=./build/voice/s1.srt");
    expect(args).toContain("hyperframes remove-background ./assets/portrait.png --output=./build/portrait.png");
    // The transcription reads what the tts task wrote, in the same film.
    expect(existsSync(p.path("build/voice/transcript.json"))).toBe(true);
    expect(existsSync(p.path("build/voice/s1.srt"))).toBe(true);

    const built = p.json<{ total: number; subtitles: string; warnings: string[] }>("build");
    expect(built.err?.errors?.map((e) => `${e.field}: ${e.message}`).join("\n")).toBeUndefined();
    expect(built.exitCode).toBe(0);
    expect(built.out!.total).toBe(4); // the narration is 3.5s, the scene asks for 4
    // The whole-film SRT keeps its own timings, and the cue past the film end is clipped with a warning.
    const srt = readFileSync(p.path("build/t.srt"), "utf8");
    expect(srt).toContain("00:00:00,400 --> 00:00:01,900");
    expect(srt).toContain("00:00:02,000 --> 00:00:04,000");
    expect(built.out!.warnings.join("\n")).toMatch(/subtitle cue in captions at 2s runs past 4s and was clipped/);
    // The matted portrait composites over the film (alpha picture on the overlay path).
    const fg = readFileSync(p.path("build/compose.filtergraph.txt"), "utf8");
    expect(fg).toContain("scale=120:-1");
  });

  test("scenes[].audio and subtitles.source are validated", () => {
    // A scene's audio must name an audio asset, and cannot also produce its own.
    const base = narrationFilm("scenes");
    p.write("filmkit.yaml", base.replace("    audio: voice", "    audio: portrait"));
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/asset "portrait" is image, a scene's audio needs kind: audio/);
    p.write("filmkit.yaml", base.replace("    audio: voice", "    audio: ghost"));
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/unknown asset "ghost"/);
    p.write("filmkit.yaml", base.replace("produces: { image: ./assets/card.png }", "produces: { image: ./assets/card.png, audio: ./build/voice/s1.wav }"));
    expect(p.json("validate").err!.errors.map((e) => e.message).join("\n")).toMatch(/cannot both produce its own audio and name an audio asset/);

    // A subtitle track pointing at a non-subtitle asset is refused.
    p.write("filmkit.yaml", narrationFilm("voice"));
    const wrongKind = p.json("validate");
    expect(wrongKind.exitCode).toBe(2);
    expect(wrongKind.err!.errors[0]!.field).toBe("timeline.tracks[1].source");
    expect(wrongKind.err!.errors[0]!.message).toMatch(/asset "voice" is audio, the subtitle track needs kind: subtitle/);

    p.write("filmkit.yaml", narrationFilm("ghost"));
    const unknown = p.json("validate");
    expect(unknown.exitCode).toBe(2);
    expect(unknown.err!.errors[0]!.message).toMatch(/unknown asset "ghost"/);

    // A static .srt asset works too, and its absence is a missing input rather than a crash.
    const staticSource = narrationFilm("captions").replace(
      `  transcript:
    kind: file
    impl:
      profile: hyperframes
      task: transcribe
      params: { input: ./build/voice/s1.wav, dir: ./build/voice, language: zh, model: large-v3 }
    produces: { file: ./build/voice/transcript.json }
  captions:
    kind: subtitle
    impl:
      profile: hyperframes
      task: subtitles
      params: { transcript: ./build/voice/transcript.json }
    produces: { subtitle: ./build/voice/s1.srt }`,
      "  captions: { kind: subtitle, uri: ./captions.srt }",
    );
    p.write("filmkit.yaml", staticSource);
    const missing = p.json<{ missingFiles: { path: string }[] }>("plan");
    expect(missing.out!.missingFiles.map((m) => m.path)).toContain("./captions.srt");
    writeFileSync(p.path("captions.srt"), readFileSync(p.path("stub.srt"), "utf8"));
    expect(p.cli("validate").exitCode).toBe(0);
    p.cli("run", "voice");
    p.cli("run", "portrait");
    expect(p.cli("build").exitCode).toBe(0);
    expect(readFileSync(p.path("build/t.srt"), "utf8")).toContain("00:00:00,400");
  });

  test("a missing caption source stays visible unless the profile says otherwise", () => {
    // `--optional` is off by default, so a tool that cannot transcribe fails the node.
    const bin = mkdtempSync(join(tmpdir(), "filmkit-stub-narr-fail-"));
    // Everything works except transcription, which reports the missing model.
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh
for a in "$@"; do
  case "$a" in
    transcribe) echo "whisper-cpp is not installed" >&2; exit 1 ;;
  esac
done
exec "${stubDir}/npx" "$@"
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      p.write("filmkit.yaml", narrationFilm("captions"));
      expect(p.cli("run", "voice").exitCode).toBe(0); // the narration exists first
      const r = p.json("run", "transcript");
      expect(r.exitCode).toBe(4);
      expect(r.err!.errors[0]!.hint).toMatch(/whisper-cpp is not installed/);
      expect(existsSync(p.path("build/voice/transcript.json"))).toBe(false);
    } finally {
      process.env.PATH = `${stubDir}:${prevPath}`;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("the narration decides the scene length (durationPolicy: min)", () => {
    media.wav(p.path("stub-voice.wav"), 6.5);
    p.write("filmkit.yaml", narrationFilm("captions"));
    for (const id of ["voice", "transcript", "captions", "portrait"]) p.cli("run", id);
    const plan = p.json<{ timeline: { total: number; scenes: { id: string; duration: number }[] } }>("plan");
    expect(plan.out!.timeline.scenes[0]!.duration).toBe(6.5); // longer than the planned 4s
    expect(plan.out!.timeline.total).toBe(6.5);
    expect(probe(p.path("build/voice/s1.wav")).duration).toBeGreaterThan(6);
  });
});
