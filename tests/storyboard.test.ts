// E2E for `filmkit storyboard`: the review sheet (JSON + HTML) that the skill
// mandates before the first paid generation (AGENTS.md rule 1 and 4: happy
// path E2E, and every failure leaves no artifact and no lock change).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { film, media, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  media.png(p.path("assets/a.png"), 100, 100);
  media.wav(p.path("assets/voice.wav"), 2.5);
  media.wav(p.path("assets/bgm.wav"), 1.0, 220);
  media.mp4(p.path("assets/clip.mp4"), 1.5, { audio: true });
  p.write("assets/voice.srt", "1\n00:00:00,200 --> 00:00:01,000\nhello\n\n2\n00:00:01,500 --> 00:00:09,000\nlate cue clipped\n");
  // assets/poster.png is deliberately absent: exercises the missing-file section.
});
afterEach(() => p.cleanup());

/** intro (ready) + footage (ready) + card (missing, blocked on an unproduced generated asset). */
const sbFilm = film({
  assets: `  bgm: { kind: audio, uri: ./assets/bgm.wav }
  poster: { kind: image, uri: ./assets/poster.png }
  ghost:
    kind: audio
    impl:
      profile: filmkit/ffmpeg
      task: exec
      params: { args: ["-f", "lavfi", "-i", "sine=frequency=880:duration=1", "\${produces.audio}"] }
    produces: { audio: ./build/ghost.wav }`,
  scenes: `  - id: intro
    duration: 2
    durationPolicy: min
    intent: { description: "开场 <b>镜头</b>", narration: { text: hello } }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/a.png, audio: ./assets/voice.wav, subtitle: ./assets/voice.srt }
  - id: footage
    transition: { type: crossfade, duration: 0.4 }
    impl: { profile: filmkit/static, task: clip }
    produces: { video: ./assets/clip.mp4 }
  - id: card
    duration: 1
    inputs: [ghost]
    intent: { description: 尾卡 }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./build/card.png }`,
  tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.3 }
    - { id: mark, kind: overlay, asset: poster, position: bottom-right, width: 40 }
    - { id: subs, kind: subtitles, source: scenes, mode: sidecar }`,
});

interface StoryboardJson {
  film: string;
  filmSha256: string;
  title: string;
  output: { path: string; container: string; width: number; height: number; fps: number };
  artifacts: { json: string; html: string };
  timeline: { total: number; scenes: { id: string; start: number; end: number; estimated: boolean }[] };
  summary: {
    shots: number;
    ready: number;
    blocked: number;
    missing: number;
    partial: number;
    stale: number;
    estimated: number;
    missingFiles: number;
    media: { present: number; total: number };
  };
  scenes: {
    index: number;
    id: string;
    start: number;
    end: number;
    status: string;
    blocked: boolean;
    transition: { type: string; duration?: number };
    intent?: { description?: string };
    executor: string;
    inputs: { id: string; kind?: string; path: string; exists: boolean; href?: string }[];
    produces: { kind: string; path: string; exists: boolean; href?: string; bytes?: number; duration?: number; text?: string }[];
  }[];
  assets: {
    id: string;
    kind: string;
    source: string;
    exists: boolean;
    status?: string;
    uri?: string;
    media: { path: string; exists: boolean; href?: string }[];
  }[];
  tracks: { id: string; kind: string; media?: { path: string; exists: boolean; href?: string }[] }[];
  missingFiles: { path: string; field: string; usedBy: string[] }[];
}

describe("storyboard", () => {
  test("writes a regular JSON sheet with statuses, hrefs and probed durations", () => {
    p.write("filmkit.yaml", sbFilm);
    const r = p.json<StoryboardJson>("storyboard");
    expect(r.exitCode).toBe(0);
    const sb = r.out!;

    // `--json` stdout is byte-identical to build/storyboard.json: one source of truth.
    const file = readFileSync(p.path("build/storyboard.json"), "utf8");
    expect(r.exitCode).toBe(0);
    expect(file).toBe(JSON.stringify(sb, null, 2) + "\n");

    expect(sb.film).toBe("./filmkit.yaml");
    expect(sb.filmSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sb.artifacts).toEqual({ json: "build/storyboard.json", html: "build/storyboard.html" });

    // Timeline comes from the same derivation `plan` uses.
    const plan = p.json<{ timeline: { total: number } }>("plan");
    expect(sb.timeline.total).toBe(plan.out!.timeline.total);
    expect(sb.timeline.scenes.map((s) => s.id)).toEqual(["intro", "footage", "card"]);

    // Per-shot status: ready / ready / missing+blocked (ghost asset not produced).
    const [intro, footage, card] = sb.scenes;
    expect([intro!.status, footage!.status, card!.status]).toEqual(["ready", "ready", "missing"]);
    expect(intro!.blocked).toBe(false);
    expect(card!.blocked).toBe(true);
    expect(card!.inputs[0]!.id).toBe("ghost");
    expect(card!.inputs[0]!.exists).toBe(false);
    expect(card!.inputs[0]!.href).toBeUndefined();
    expect(footage!.transition).toEqual({ type: "crossfade", duration: 0.4 });
    expect(intro!.executor).toBe("place files");

    // Existing media carries a preview href relative to build/ plus probe facts.
    const image = intro!.produces.find((m) => m.kind === "image")!;
    expect(image.href).toBe("../assets/a.png");
    expect(image.exists).toBe(true);
    expect(image.bytes).toBeGreaterThan(0);
    const audio = intro!.produces.find((m) => m.kind === "audio")!;
    expect(audio.duration).toBeCloseTo(2.5, 1);
    const subtitle = intro!.produces.find((m) => m.kind === "subtitle")!;
    expect(subtitle.text).toContain("hello");
    const missingCard = card!.produces[0]!;
    expect(missingCard.exists).toBe(false);
    expect(missingCard.href).toBeUndefined();

    // Assets: file-backed vs generated node, with existence.
    const bgm = sb.assets.find((a) => a.id === "bgm")!;
    expect(bgm).toMatchObject({ source: "file", exists: true, uri: "./assets/bgm.wav" });
    expect(bgm.media[0]!.href).toBe("../assets/bgm.wav");
    const poster = sb.assets.find((a) => a.id === "poster")!;
    expect(poster.exists).toBe(false);
    const ghost = sb.assets.find((a) => a.id === "ghost")!;
    expect(ghost).toMatchObject({ source: "node", status: "missing", exists: false });
    expect(ghost.media[0]!.href).toBeUndefined();

    // Tracks carry their asset's media for playback on the sheet.
    const music = sb.tracks.find((t) => t.id === "music")!;
    expect(music.media![0]).toMatchObject({ path: "./assets/bgm.wav", exists: true, href: "../assets/bgm.wav" });
    expect(sb.tracks.find((t) => t.id === "subs")!.media).toBeUndefined();

    expect(sb.missingFiles).toEqual([
      { path: "./assets/poster.png", field: "assets.poster.uri", usedBy: ["track:mark"] },
    ]);

    expect(sb.summary).toEqual({
      shots: 3,
      ready: 2,
      blocked: 1,
      missing: 1,
      partial: 0,
      stale: 0,
      estimated: 0,
      missingFiles: 1,
      media: { present: 5, total: 8 },
    });

    // No absolute machine paths leak into either artifact (they get copied around).
    const html = readFileSync(p.path("build/storyboard.html"), "utf8");
    expect(html).not.toContain(p.dir);
    expect(JSON.stringify(sb)).not.toContain(p.dir);
  });

  test("the HTML sheet previews, plays back, and marks what is missing", () => {
    p.write("filmkit.yaml", sbFilm);
    expect(p.cli("storyboard").exitCode).toBe(0);
    const html = readFileSync(p.path("build/storyboard.html"), "utf8");

    // Playback primitives with hrefs relative to build/storyboard.html.
    expect(html).toContain(`<img loading="lazy" src="../assets/a.png"`);
    expect(html).toContain(`<video controls preload="metadata" src="../assets/clip.mp4"></video>`);
    expect(html).toContain(`<audio controls preload="metadata" src="../assets/voice.wav"></audio>`);
    expect(html).toContain(`<audio controls preload="metadata" src="../assets/bgm.wav"></audio>`); // bgm track in the table

    // Missing media becomes an explicit placeholder, never a broken element.
    expect(html).toContain("尚未产出");
    expect(html).toContain("./build/card.png");
    expect(html).toContain("./build/ghost.wav");
    expect(html).toContain("./assets/poster.png");

    // Subtitle cues are embedded for proofing; intent text is HTML-escaped.
    expect(html).toContain("late cue clipped");
    expect(html).toContain("开场 &lt;b&gt;镜头&lt;/b&gt;");
    expect(html).not.toContain("<b>镜头</b>");

    // Blocked/status stamps, timeline anchors, and no unfilled placeholders.
    expect(html).toContain(`class="stamp st-missing"`);
    expect(html).toContain(`class="stamp st-blocked"`);
    expect(html).toContain(`href="#shot-footage"`);
    expect(html).not.toMatch(/\{\{\w+\}\}/);

    // The data file is linked from the footer.
    expect(html).toContain("build/storyboard.json");
  });

  test("is deterministic, writes no lock, and never disturbs an existing one", () => {
    p.write("filmkit.yaml", sbFilm);
    expect(p.cli("storyboard").exitCode).toBe(0);
    expect(existsSync(p.path("filmkit.lock.yaml"))).toBe(false);
    const json1 = readFileSync(p.path("build/storyboard.json"), "utf8");
    const html1 = readFileSync(p.path("build/storyboard.html"), "utf8");

    expect(p.cli("storyboard").exitCode).toBe(0);
    expect(readFileSync(p.path("build/storyboard.json"), "utf8")).toBe(json1);
    expect(readFileSync(p.path("build/storyboard.html"), "utf8")).toBe(html1);

    // status writes the lock; a storyboard run must leave it byte-identical.
    expect(p.cli("status").exitCode).toBe(0);
    const lock = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    expect(p.cli("storyboard").exitCode).toBe(0);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(lock);
  });

  test("failure: an invalid film writes nothing at all", () => {
    p.write(
      "filmkit.yaml",
      film({ scenes: `  - id: s1\n    duration: 1\n    impl: { profile: nope, task: x }\n    produces: { image: ./assets/a.png }` }),
    );
    const r = p.json("storyboard");
    expect(r.exitCode).toBe(2);
    expect(existsSync(p.path("build/storyboard.json"))).toBe(false);
    expect(existsSync(p.path("build/storyboard.html"))).toBe(false);
    expect(existsSync(p.path("filmkit.lock.yaml"))).toBe(false);
  });

  test("failure: a blocked target leaves no partial file and no tmp litter", () => {
    p.write("filmkit.yaml", sbFilm);
    // Make the JSON rename target unwritable: it is an existing directory.
    mkdirSync(p.path("build/storyboard.json"), { recursive: true });
    const r = p.json("storyboard");
    expect(r.exitCode).toBe(1);
    expect(r.err!.errors[0]!.code).toBe("io");
    expect(r.err!.errors[0]!.message).toMatch(/cannot write storyboard artifacts/);
    expect(existsSync(p.path("build/storyboard.html"))).toBe(false);
    expect(readdirSync(p.path("build"))).not.toContain("storyboard.json.tmp");
    expect(readdirSync(p.path("build"))).not.toContain("storyboard.html.tmp");
    expect(existsSync(p.path("filmkit.lock.yaml"))).toBe(false);
  });
});
