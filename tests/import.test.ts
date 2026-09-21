// `filmkit import hyperstory`: a Hyperstory Video Composition Schema becomes a
// filmkit Film. The import is one-way and lossy on purpose — everything filmkit
// cannot express is reported, not invented.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { media, probe, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => (p = project()));
afterEach(() => p.cleanup());

const SCHEMA = {
  version: "1.0",
  title: "深夜律所走廊",
  duration: 20,
  cover: "./assets/images/cover.png",
  coverDuration: 3,
  render: { width: 640, height: 360, fps: 25 },
  defaults: { visualStyle: "暗色编辑风", imageFit: "cover", bgmVolume: 0.1, bgmFadeOutDuration: 2 },
  audio: { bgm: "./assets/audio/bgm.mp3", voiceMap: { default: "./assets/audio/voices/default.mp3" } },
  scenes: [
    {
      id: "scene-01",
      start: 3,
      duration: 4,
      image: "./assets/images/scene-01.png",
      voice: "./assets/voice/scene-01.wav",
      subtitle: "./assets/subtitles/scene-01.srt",
      voiceRef: "default",
      voiceInstruct: "冷静",
      voiceSpeed: 1.0,
      voiceText: "深夜的律所走廊，只有一盏灯亮着。",
      caption: "源头，是内鬼",
      description: "空荡的走廊",
      action: "镜头缓慢推进",
    },
    {
      id: "scene-02",
      duration: 5,
      image: "./assets/images/scene-02.png",
      video: "./assets/video/scene-02.mp4",
      videoPrompt: "文件夹被推近",
      videoAudio: { enabled: false, volume: 0.4 },
      voice: "./assets/voice/scene-02.wav",
      voiceRef: "default",
      voiceText: "第二次谈话。",
      description: "桌面特写",
    },
  ],
};

const writeSchema = (over: Record<string, unknown> = {}) => p.write("schema.json", JSON.stringify({ ...SCHEMA, ...over }));

interface ImportJson {
  out: string;
  scenes: number;
  assets: number;
  warnings: string[];
  missingFiles: string[];
}

describe("import hyperstory", () => {
  test("maps scenes, assets, tracks and the cover card; reports what it cannot express", () => {
    writeSchema();
    const r = p.json<ImportJson>("import", "hyperstory", "./schema.json");
    expect(r.exitCode).toBe(0);
    expect(r.out!.scenes).toBe(3); // cover + 2 scenes
    expect(r.out!.missingFiles).toEqual(["./assets/audio/bgm.mp3", "./assets/audio/voices/default.mp3"]);
    expect(r.out!.warnings.join("\n")).toMatch(/defaults.visualStyle has no filmkit equivalent/);
    expect(r.out!.warnings.join("\n")).toMatch(/videoAudio.enabled=false/);
    expect(r.out!.warnings.join("\n")).toMatch(/videoAudio.volume=0.4 is not expressible/);
    expect(r.out!.warnings.join("\n")).toMatch(/point impl at a video-generation Profile/);

    const yaml = readFileSync(p.path("filmkit.yaml"), "utf8");
    expect(yaml).toMatch(/kind: Film/);
    expect(yaml).toMatch(/name: schema/);
    expect(yaml).toMatch(/width: 640, height: 360, fps: 25/);
    expect(yaml).toMatch(/fit: cover/);
    expect(yaml).toMatch(/durationPolicy: min/); // narration decides the floor
    expect(yaml).toMatch(/durationPolicy: exact/); // cover card
    expect(yaml).toMatch(/narration: \{ text: "深夜的律所走廊，只有一盏灯亮着。", voiceRef: voice-default \}/);
    expect(yaml).toMatch(/audioMode: replace/); // videoAudio.enabled: false
    expect(yaml).toMatch(/volume: 0.1, fadeOut: 2/);
    expect(yaml).toMatch(/kind: subtitles, source: scenes, mode: sidecar/);
    // The prompt is not lost even though filmkit has no field for it.
    expect(yaml).toMatch(/"hyperstory.videoPrompt.scene-02": "文件夹被推近"/);
    // A planned duration stays a plan: it must not become a build-time contract.
    expect(yaml).toMatch(/"hyperstory.plannedDuration": 20/);
    expect(yaml).not.toMatch(/duration: \{ planned/);
  });

  test("the imported film is already plan-able, and validate only complains about files not in place", () => {
    writeSchema();
    expect(p.cli("import", "hyperstory", "./schema.json").exitCode).toBe(0);

    const v = p.json("validate");
    expect(v.exitCode).toBe(2);
    expect(v.err!.errors.map((e) => e.field)).toEqual(["assets.bgm.uri", "assets.voice-default.uri"]);

    const plan = p.json<{ missingFiles: { path: string }[]; nodes: { id: string; executor: string }[] }>("plan");
    expect(plan.exitCode).toBe(0);
    expect(plan.out!.missingFiles.map((m) => m.path)).toEqual(["./assets/audio/bgm.mp3", "./assets/audio/voices/default.mp3"]);
    expect(plan.out!.nodes.map((n) => n.id).sort()).toEqual(["cover", "scene-01", "scene-02"]);
    expect(plan.out!.nodes.every((n) => n.executor === "place files")).toBe(true);
  });

  test("place the files and the imported project builds without touching the schema again", () => {
    writeSchema();
    p.cli("import", "hyperstory", "./schema.json");
    media.png(p.path("assets/images/cover.png"), 100, 60);
    media.png(p.path("assets/images/scene-01.png"), 100, 60);
    media.mp4(p.path("assets/video/scene-02.mp4"), 2, { audio: true });
    media.wav(p.path("assets/voice/scene-01.wav"), 2);
    media.wav(p.path("assets/voice/scene-02.wav"), 3);
    media.wav(p.path("assets/audio/bgm.mp3").replace(/mp3$/, "mp3"), 2, 220); // odd name, real container
    media.wav(p.path("assets/audio/voices/default.mp3"), 1);
    p.write("assets/subtitles/scene-01.srt", "1\n00:00:00,100 --> 00:00:01,200\n深夜\n");

    const v = p.json("validate");
    expect(v.err?.errors?.map((e) => `${e.field}: ${e.message}`).join("\n")).toBeUndefined();
    const built = p.json<{ total: number; subtitles: string }>("build");
    expect(built.exitCode).toBe(0);
    // cover 3 + max(4, 2) + max(5, 3) = 12
    expect(built.out!.total).toBe(12);
    const pr = probe(p.path("build/schema.mp4"));
    expect([pr.width, pr.height, pr.fps, pr.vcodec]).toEqual([640, 360, 25, "h264"]);
    expect(existsSync(p.path(built.out!.subtitles))).toBe(true);
    expect(readFileSync(p.path(built.out!.subtitles), "utf8")).toMatch(/00:00:03,100 --> 00:00:04,200/); // shifted past the cover
  });

  test("refuses to overwrite an existing film without --force", () => {
    writeSchema();
    p.write("filmkit.yaml", "# hand written\n");
    const r = p.json("import", "hyperstory", "./schema.json");
    expect(r.exitCode).toBe(1);
    expect(r.err!.errors[0]!.message).toMatch(/refusing to overwrite/);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe("# hand written\n");
    expect(p.cli("import", "hyperstory", "./schema.json", "--force").exitCode).toBe(0);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toMatch(/kind: Film/);
  });

  test("--out writes elsewhere; a bad schema fails with a source field", () => {
    writeSchema();
    expect(p.cli("import", "hyperstory", "./schema.json", "--out", "films/other.yaml").exitCode).toBe(0);
    expect(existsSync(p.path("films/other.yaml"))).toBe(true);

    writeSchema({ scenes: [] });
    expect(p.json("import", "hyperstory", "./schema.json", "--force").err!.errors[0]!.message).toMatch(/scenes must be a non-empty array/);
    writeSchema({ scenes: [{ id: "s", image: "./x.png" }] });
    expect(p.json("import", "hyperstory", "./schema.json", "--force").err!.errors[0]!.message).toMatch(/has no usable duration/);
    writeSchema({ scenes: [{ id: "s", duration: 3 }] });
    expect(p.json("import", "hyperstory", "./schema.json", "--force").err!.errors[0]!.message).toMatch(/neither image nor video/);
    expect(p.json("import", "unknown-kind", "./schema.json").exitCode).toBe(2);
    expect(p.json("import", "hyperstory", "./missing.json").exitCode).toBe(1);
  });
});
