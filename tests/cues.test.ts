// `fit: exact` cadence check (docs/spec.md §1.8.2, §7): the music's segment
// boundaries must land on picture cuts, and the piece must cover the span.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  media.png(p.path("a.png"));
  media.png(p.path("b.png"));
  media.wav(p.path("music.wav"), 7.5, 220);
});
afterEach(() => p.cleanup());

/** Two scenes 3s + 4s, one exact-fit music track covering all 7s. */
const exactFilm = (track: string, extra = "") =>
  film({
    assets: "  music: { kind: audio, uri: ./music.wav }",
    scenes: `  - id: s1
    duration: 3
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./a.png }
  - id: s2
    duration: 4
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./b.png }`,
    tracks: `    - ${track}`,
    extra,
  });

const cues = (entries: [number, number][]) =>
  JSON.stringify({ version: "filmkit/cues-v1", cues: entries.map(([start, end], i) => ({ id: `seg-${i + 1}`, start, end })) }, null, 2);

describe("fit: exact", () => {
  test("aligned boundaries pass and build produces a 7s film", () => {
    p.write("cues.json", cues([[0, 3], [3, 7]]));
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }"));
    expect(p.cli("validate").exitCode).toBe(0);
    expect(p.cli("build").exitCode).toBe(0);
    expect(Math.abs(probe(p.path("build/t.mp4")).duration - 7)).toBeLessThan(0.15);
  });

  test("a boundary off by more than the tolerance fails with the measured offset", () => {
    p.write("cues.json", cues([[0, 3.2], [3.2, 7]]));
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }"));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    const e = r.err!.errors[0]!;
    expect(e.field).toBe("timeline.tracks[0].tolerance");
    expect(e.message).toMatch(/cue boundary "seg-2" lands at 3.2s but the nearest picture cut is 3s \(off by 0\.2s > tolerance 0\.05s\)/);
    expect(p.cli("build").exitCode).toBe(2); // build refuses too, even if validate was skipped
  });

  test("the per-track tolerance loosens or tightens the check", () => {
    p.write("cues.json", cues([[0, 3.2], [3.2, 7]]));
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json, tolerance: 0.25 }"));
    expect(p.cli("validate").exitCode).toBe(0);
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json, tolerance: 0.001 }"));
    expect(p.cli("validate").exitCode).toBe(2);
  });

  test("music shorter than the span is refused (exact neither loops nor pads)", () => {
    // 2.5s segments are aligned with the 3s cut, and the piece simply stops early.
    p.write("cues.json", cues([[0, 3], [3, 5]]));
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }"));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors.map((e) => e.message).join("\n")).toMatch(/music ends at 5s but must cover 7s \(short by 2s/);
  });

  test("a crossfade moves the cut to the middle of the transition", () => {
    p.write("cues.json", cues([[0, 3.25], [3.25, 7]]));
    p.write(
      "filmkit.yaml",
      exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }").replace("    duration: 4\n", "    duration: 4\n    transition: { type: crossfade, duration: 0.5 }\n"),
    );
    // Scene 2 starts at 2.5 (3 - 0.5), the perceptual cut is 2.5 + 0.25 = 2.75.
    expect(p.cli("validate").exitCode).toBe(2);
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/nearest picture cut is 2\.75s/);
    p.write("cues.json", cues([[0, 2.75], [2.75, 6.5]]));
    expect(p.cli("validate").exitCode).toBe(0);
  });

  test("the cue file must exist, be filmkit/cues-v1, ordered and well-formed", () => {
    const track = "{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }";
    p.write("filmkit.yaml", exactFilm(track));
    const missing = p.json("validate");
    expect(missing.exitCode).toBe(2);
    expect(missing.err!.errors[0]!.message).toMatch(/referenced file is not in place: \.\/cues\.json/);
    // `plan` still works and tells the agent to produce it.
    const plan = p.json<{ missingFiles: { path: string; usedBy: string[] }[] }>("plan");
    expect(plan.exitCode).toBe(0);
    expect(plan.out!.missingFiles).toEqual([{ path: "./cues.json", field: "timeline.tracks[0].cues", usedBy: ["track:music"] }] as never);

    p.write("cues.json", JSON.stringify({ version: "filmkit/cues-v1", cues: [{ start: 3, end: 7 }, { start: 0, end: 3 }] }));
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/overlap or out of order/);
    p.write("cues.json", JSON.stringify({ version: "whatever", cues: [{ start: 0, end: 7 }] }));
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/must be "filmkit\/cues-v1"/);
    p.write("cues.json", JSON.stringify({ version: "filmkit/cues-v1", cues: [{ start: 0, end: 7 }], extra: 1 }));
    expect(p.json("validate").err!.errors[0]!.message).toMatch(/unknown field "extra"/);
  });

  test("plan reports the cue file half of the work before the music exists", () => {
    p.write("filmkit.yaml", exactFilm("{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }"));
    const plan = p.json<{ timeline: { scenes: { id: string; estimated: boolean }[] } }>("plan");
    // Scene durations are explicit (`exact`), so they are known even though the images are placeholders…
    expect(plan.out!.timeline.scenes.map((s) => s.estimated)).toEqual([false, false]);
  });
});
