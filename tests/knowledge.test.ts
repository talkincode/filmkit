// Knowledge-video batch: chapters, narration ducking, burned subtitles and
// `import script`. Each feature gets a happy-path E2E plus its failure path
// (AGENTS.md: high-risk features need both, state-mutating ones need recovery).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { media, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  media.png(p.path("assets/a.png"), 160, 90);
  media.png(p.path("assets/b.png"), 160, 90, "0x993333");
  media.wav(p.path("assets/voice.wav"), 2.0);
  media.wav(p.path("assets/bgm.wav"), 1.0, 220);
});
afterEach(() => p.cleanup());

const baseScenes = `  - id: s1
    duration: 2
    durationPolicy: min
    intent: { description: "Part one", narration: { text: "hello" } }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/a.png, audio: ./assets/voice.wav }
  - id: s2
    duration: 1.5
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/b.png }`;

const baseOutput = `output:
  container: mp4
  video: { width: 160, height: 90, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }`;

function filmWith(timeline: string): string {
  return `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: t, title: Chapters }
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
assets:
  bgm: { kind: audio, uri: ./assets/bgm.wav }
${baseOutput}
scenes:
${baseScenes}
timeline:
${timeline}`;
}

/** Whether this ffmpeg can burn subtitles (libass). Env-dependent: the burn
 *  test builds for real when it can, and asserts the clean exit-3 path when not. */
function hasSubtitlesFilter(): boolean {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  return /\ssubtitles\s/.test(r.stdout);
}

describe("chapters", () => {
  test("scene-ref chapters plan deterministically and export as container chapters", () => {
    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: Opening, scene: s1 }
    - { title: Closer, scene: s2 }`));
    expect(p.cli("validate").exitCode).toBe(0);
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    // Deterministic ffmetadata next to the filtergraph.
    const first = readFileSync(p.path("build/chapters.txt"), "utf8");
    expect(first).toBe(
      ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=3500\ntitle=Closer\n",
    );
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    expect(readFileSync(p.path("build/chapters.txt"), "utf8")).toBe(first);
    expect(readFileSync(p.path("build/compose.filtergraph.txt"), "utf8")).toMatch(/-map_chapters 2/);
    const r = p.json<{ output: string; chapters: string; total: number }>("build");
    expect(r.exitCode).toBe(0);
    expect(r.out!.total).toBe(3.5);
    expect(r.out!.chapters).toBe("build/chapters.txt");
    // The chapters survived the encode: ffprobe sees them with titles and starts.
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_chapters", "-print_format", "json", p.path("build/t.mp4")], { encoding: "utf8" });
    const chapters = JSON.parse(probe.stdout).chapters;
    expect(chapters.map((c: { tags: { title: string } }) => c.tags.title)).toEqual(["Opening", "Closer"]);
    expect(chapters.map((c: { start_time: string }) => c.start_time)).toEqual(["0.000000", "2.000000"]);
  });

  test("absolute starts and planning are deterministic", () => {
    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: A, start: 0 }
    - { title: B, start: 1.25 }`));
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    const first = readFileSync(p.path("build/chapters.txt"), "utf8");
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    expect(readFileSync(p.path("build/chapters.txt"), "utf8")).toBe(first);
    expect(first).toContain("START=1250");
  });

  test("failure: unknown scene, out-of-range start and disorder are invalid input", () => {
    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: Ghost, scene: ghost }`));
    let r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/unknown scene "ghost"/);

    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: Late, start: 99 }`));
    r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/beyond the total duration/);

    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: B, start: 1 }
    - { title: A, start: 0.5 }`));
    r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/does not come after/);

    // Schema: exactly one of scene/start.
    p.write("filmkit.yaml", filmWith(`  chapters:
    - { title: Both, scene: s1, start: 0 }`));
    expect(p.json("validate").exitCode).toBe(2);
  });
});

describe("ducking", () => {
  const duckedFilm = filmWith(`  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.5, duck: { amount: 0.8 } }`);

  test("a ducked bgm plans a sidechain graph deterministically and builds a spec-conformant mp4", () => {
    p.write("filmkit.yaml", duckedFilm);
    expect(p.cli("validate").exitCode).toBe(0);
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    const fg = readFileSync(p.path("build/compose.filtergraph.txt"), "utf8");
    expect(fg).toContain("asplit=2[curA_mix][sc0]");
    expect(fg).toContain("[trk0][sc0]sidechaincompress=threshold=0.02:ratio=20:attack=20:release=250:mix=0.8[trkd0]");
    // Ducking twice plans byte-identically.
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    expect(readFileSync(p.path("build/compose.filtergraph.txt"), "utf8")).toBe(fg);
    const r = p.json<{ output: string; total: number }>("build");
    expect(r.exitCode).toBe(0);
    expect(r.out!.total).toBe(3.5);
  });

  test("failure: amount outside 0..1 is invalid input", () => {
    p.write("filmkit.yaml", filmWith(`  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, duck: { amount: 2 } }`));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
  });
});

describe("burn", () => {
  const burnFilm = (mode: string) =>
    `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: t }
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
${baseOutput}
scenes:
  - id: s1
    duration: 2
    durationPolicy: min
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/a.png, audio: ./assets/voice.wav, subtitle: ./assets/voice.srt }
timeline:
  tracks:
    - { id: subs, kind: subtitles, source: scenes, mode: ${mode} }`;

  beforeEach(() => {
    p.write("assets/voice.srt", "1\n00:00:00,200 --> 00:00:01,000\nhello\n");
  });

  test("dry-run plans the subtitles filter and still writes the sidecar for review", () => {
    p.write("filmkit.yaml", burnFilm("burn"));
    expect(p.cli("validate").exitCode).toBe(0);
    const r = p.json<{ subtitles: string }>("build", "--dry-run");
    expect(r.exitCode).toBe(0);
    const fg = readFileSync(p.path("build/compose.filtergraph.txt"), "utf8");
    expect(fg).toContain("subtitles='./build/t.srt'");
    expect(readFileSync(p.path("build/t.srt"), "utf8")).toContain("hello");
  });

  test("real build: burns when libass exists, else fails clean with exit 3", () => {
    p.write("filmkit.yaml", burnFilm("burn"));
    p.cli("status"); // a lock to prove recovery leaves it untouched
    const before = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    const r = p.json("build");
    if (hasSubtitlesFilter()) {
      expect(r.exitCode).toBe(0);
      expect(r.out).toBeDefined();
    } else {
      expect(r.exitCode).toBe(3);
      expect(r.err!.errors[0]!.code).toBe("missing-dependency");
      expect(r.err!.errors[0]!.message).toMatch(/subtitles.*libass/);
      expect(existsSync(p.path("build/t.mp4"))).toBe(false);
      expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(before);
    }
  });
});

describe("import script", () => {
  const script = `# How Narratives Work

Intro prose that belongs to no scene.

## Opening

This is the opening narration, roughly forty characters long here.

![](cards/opening.png)

## 原理

- first point
- second point

## Opening

A repeated heading gets a unique id.
`;

  test("markdown sections become narration scenes usable by plan", () => {
    media.png(p.path("cards/opening.png"), 160, 90);
    p.write("script.md", script);
    const r = p.json<{ out: string; scenes: number; missingFiles: string[]; warnings: string[] }>("import", "script", "script.md");
    expect(r.exitCode).toBe(0);
    expect(r.out!.scenes).toBe(3);
    expect(r.out!.missingFiles).toEqual(["./assets/scene-02.png", "./assets/opening-2.png"]);
    const film = readFileSync(p.path("filmkit.yaml"), "utf8");
    expect(film).toContain("title: \"How Narratives Work\"");
    expect(film).toContain("image: \"cards/opening.png\"");
    expect(film).toContain("scene-02"); // CJK heading falls back to scene-NN
    expect(film).toContain("opening-2"); // repeated heading is deduplicated
    expect(film).toContain("durationPolicy: min");
    // Usable by plan immediately: the scenes are work, the pictures are listed.
    const plan = p.json<{ nodes: { id: string; executor: string }[]; missingFiles: { path: string }[] }>("plan");
    expect(plan.exitCode).toBe(0);
    // "opening" is ready (its picture exists); the other two are work.
    expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([
      ["scene-02", "place files"],
      ["opening-2", "place files"],
    ]);
    expect(plan.out!.missingFiles).toEqual([]);
    // Deterministic: importing again (with --force) yields the same file.
    const first = readFileSync(p.path("filmkit.yaml"), "utf8");
    expect(p.cli("import", "script", "script.md", "--out", "filmkit.yaml", "--force").exitCode).toBe(0);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe(first);
  });

  test("duration estimate follows the documented rule", () => {
    p.write("script.md", `# T\n\n## A\n\n${"x".repeat(40)}\n`);
    expect(p.cli("import", "script", "script.md").exitCode).toBe(0);
    const film = readFileSync(p.path("filmkit.yaml"), "utf8");
    expect(film).toContain("duration: 10"); // 40 chars / 4 per second
    p.write("script.md", `# T\n\n## A\n\nHi\n`);
    expect(p.cli("import", "script", "script.md", "--out", "f2.yaml").exitCode).toBe(0);
    expect(readFileSync(p.path("f2.yaml"), "utf8")).toContain("duration: 2"); // floor
  });

  test("failure: missing file, no sections, overwrite refusal", () => {
    expect(p.json("import", "script", "ghost.md").exitCode).toBe(1);
    p.write("script.md", `# Just a title\n\nSome prose, no sections.\n`);
    const r = p.json("import", "script", "script.md");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/no scenes found/);
    p.write("script.md", `# T\n\n## A\n\nWords here.\n`);
    expect(p.cli("import", "script", "script.md").exitCode).toBe(0);
    expect(p.json("import", "script", "script.md").exitCode).toBe(1); // refuses to overwrite
    expect(p.cli("import", "script", "script.md", "--out", "filmkit.yaml", "--force").exitCode).toBe(0);
  });
});
