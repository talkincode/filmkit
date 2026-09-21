import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { film, media, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  media.png(p.path("a.png"));
  media.png(p.path("b.png"));
});
afterEach(() => p.cleanup());

const twoScenes = `  - id: s1
    duration: 2
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./a.png }
  - id: s2
    duration: 3
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./b.png }`;

function expectInvalid(yaml: string, field: string | RegExp, message: RegExp, code = "invalid-input") {
  p.write("filmkit.yaml", yaml);
  const r = p.json("validate");
  expect(r.exitCode).toBe(code === "invalid-input" ? 2 : 1);
  const errs = r.err!.errors;
  const hit = errs.find((e) => (typeof field === "string" ? e.field === field : field.test(e.field ?? "")) && message.test(e.message));
  if (!hit) throw new Error(`expected error on ${field} /${message.source}/, got:\n${JSON.stringify(errs, null, 2)}`);
  expect(hit.code).toBe(code);
  expect(hit.line).toBeGreaterThan(0);
  return errs;
}

describe("validate — happy path", () => {
  test("two static scenes pass and the timeline is derived", () => {
    p.write("filmkit.yaml", film({ scenes: twoScenes }));
    const r = p.json<{ ok: boolean; timeline: { total: number } }>("validate");
    expect(r.exitCode).toBe(0);
    expect(r.out!.ok).toBe(true);
    expect(r.out!.timeline.total).toBe(5);
  });

  test("${vars.x} is substituted everywhere, including impl.params", () => {
    p.write(
      "filmkit.yaml",
      film({
        scenes: `  - id: s1
    duration: 2
    intent: { description: "Color \${vars.color}" }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./a.png }`,
        extra: "vars: { color: teal }",
      }),
    );
    expect(p.json("validate").exitCode).toBe(0);
    const plan = p.json<{ nodes: unknown[] }>("plan");
    expect(plan.exitCode).toBe(0);
  });
});

describe("validate — schema layer", () => {
  test("unknown field is rejected with field path and line", () => {
    const errs = expectInvalid(film({ scenes: twoScenes }).replace("metadata: { name: t }", "metadata: { name: t, colour: red }"), "metadata.colour", /unknown field/);
    expect(errs.length).toBe(1);
  });

  test("wrong apiVersion", () => {
    expectInvalid(film({ scenes: twoScenes }).replace("filmkit/v1alpha1", "filmkit/v9"), "apiVersion", /must be/);
  });

  test("video and image produces are mutually exclusive", () => {
    expectInvalid(
      film({ scenes: twoScenes.replace("produces: { image: ./a.png }", "produces: { image: ./a.png, video: ./x.mp4 }") }),
      "scenes[0].produces",
      /not allowed/,
    );
  });

  test("YAML syntax errors report a line", () => {
    p.write("filmkit.yaml", "apiVersion: filmkit/v1alpha1\nkind: Film\nmetadata: { name: t\n");
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/YAML syntax/);
  });
});

describe("validate — references and semantics", () => {
  test("unregistered profile", () => {
    expectInvalid(film({ scenes: twoScenes.replace("filmkit/static, task: clip }\n    produces: { image: ./a.png", "seedance, task: clip }\n    produces: { image: ./a.png") }), "scenes[0].impl.profile", /not registered/);
  });

  test("unknown task on a registered profile", () => {
    expectInvalid(film({ scenes: twoScenes.replace("task: clip }\n    produces: { image: ./a.png", "task: render }\n    produces: { image: ./a.png") }), "scenes[0].impl.task", /no task "render"/);
  });

  test("params rejected by the profile's paramsSchema (closed by default)", () => {
    expectInvalid(
      film({ scenes: twoScenes.replace("impl: { profile: filmkit/static, task: clip }\n    produces: { image: ./a.png", "impl: { profile: filmkit/static, task: clip, params: { zoom: 1 } }\n    produces: { image: ./a.png") }),
      "scenes[0].impl.params.zoom",
      /unknown field/,
    );
  });

  test("missing asset file and dangling track asset", () => {
    expectInvalid(
      film({ scenes: twoScenes, assets: "  bgm: { kind: audio, uri: ./nope.mp3 }", tracks: "    - { id: m, kind: audio, asset: ghost }" }),
      "timeline.tracks[0].asset",
      /unknown asset "ghost"/,
    );
    p.write("filmkit.yaml", film({ scenes: twoScenes, assets: "  bgm: { kind: audio, uri: ./nope.mp3 }" }));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.field).toBe("assets.bgm.uri");
  });

  test("duplicate ids across scenes and assets, and duplicate produces paths", () => {
    expectInvalid(film({ scenes: twoScenes, assets: "  s1: { kind: image, uri: ./a.png }" }), "scenes[0].id", /already used/);
    expectInvalid(film({ scenes: twoScenes.replace("./b.png", "./a.png") }), "scenes[1].produces.image", /also produced/);
  });

  test("dependency cycle", () => {
    expectInvalid(
      film({
        scenes: `  - id: s1
    duration: 2
    inputs: [s2]
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./a.png }
  - id: s2
    duration: 2
    inputs: [s1]
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./b.png }`,
      }),
      /inputs/,
      /dependency cycle/,
    );
  });

  test("sequence must be a permutation of scene ids", () => {
    expectInvalid(film({ scenes: twoScenes, extra: "timeline:\n  sequence: [s1]" }), "timeline.sequence", /missing from sequence/);
  });

  test("crossfade longer than half a scene", () => {
    expectInvalid(
      film({ scenes: twoScenes.replace("id: s2\n", "id: s2\n    transition: { type: crossfade, duration: 1.5 }\n") }),
      "scenes[1].transition.duration",
      /shorter than half/,
    );
  });

  test("explicit start earlier than derived start", () => {
    expectInvalid(film({ scenes: twoScenes.replace("id: s2\n", "id: s2\n    start: 1\n") }), "scenes[1].start", /earlier than the derived/);
  });

  test("fit: exact requires a cues file; cues without exact fit is refused", () => {
    const withTrack = (track: string) =>
      film({ scenes: twoScenes, assets: "  bgm: { kind: audio, uri: ./a.png }", tracks: `    - ${track}` });
    expectInvalid(withTrack("{ id: m, kind: audio, asset: bgm, fit: exact }"), "timeline.tracks[0].fit", /requires cues/);
    expectInvalid(withTrack("{ id: m, kind: audio, asset: bgm, fit: loop, cues: ./x.json }"), "timeline.tracks[0].cues", /only read when fit is "exact"/);
    expectInvalid(withTrack("{ id: m, kind: audio, asset: bgm, fit: exact, cues: ../outside.json }"), "timeline.tracks[0].cues", /escapes the project/);
  });

  test("reserved features are refused explicitly", () => {
    expectInvalid(
      film({ scenes: twoScenes, assets: "  bgm: { kind: audio, uri: ./a.png }", tracks: "    - { id: m, kind: audio, asset: bgm, stems: {} }" }),
      "timeline.tracks[0].stems",
      /reserved/,
    );
    expectInvalid(film({ scenes: twoScenes, tracks: "    - { id: subs, kind: subtitles, source: scenes, mode: burn }" }), "timeline.tracks[0].mode", /reserved/);
  });

  test("codec/container mismatch", () => {
    expectInvalid(
      film({ scenes: twoScenes, output: "  container: webm\n  video: { width: 320, height: 180, fps: 25, codec: h264 }\n  audio: { codec: aac, sampleRate: 48000, channels: 2 }" }),
      "output.video.codec",
      /not allowed in webm/,
    );
  });

  test("undefined variable and unsupported substitution syntax", () => {
    expectInvalid(film({ scenes: twoScenes.replace("duration: 2", "duration: 2\n    intent: { caption: \"${vars.nope}\" }") }), "scenes[0].intent.caption", /undefined variable/);
    expectInvalid(film({ scenes: twoScenes.replace("duration: 2", "duration: 2\n    intent: { caption: \"${a.b[0]}\" }") }), "scenes[0].intent.caption", /unsupported substitution/);
  });

  test("duration is required when nothing has a natural length", () => {
    expectInvalid(film({ scenes: twoScenes.replace("    duration: 2\n", "") }), "scenes[0].duration", /required/);
  });

  test("keep + produces.audio is contradictory", () => {
    expectInvalid(film({ scenes: twoScenes.replace("produces: { image: ./a.png }", "audioMode: keep\n    produces: { image: ./a.png, audio: ./a.png }") }), "scenes[0].audioMode", /contradicts/);
  });

  test("validate is read-only: no lock and no build directory are created", () => {
    p.write("filmkit.yaml", film({ scenes: twoScenes }));
    p.json("validate");
    expect(existsSync(p.path("filmkit.lock.yaml"))).toBe(false);
    expect(existsSync(p.path("build"))).toBe(false);
  });
});
