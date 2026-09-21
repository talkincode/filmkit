// Pure-function tests for the pieces whose correctness is easiest to pin down
// without ffmpeg: timeline arithmetic, SRT merge, substitution, hashing.

import { describe, expect, test } from "bun:test";
import { formatSrt, mergeCues, parseSrt } from "../src/build/subtitles.ts";
import { hashParams } from "../src/hash.ts";
import { sceneDuration } from "../src/timeline.ts";
import { expandArgv, substituteVars } from "../src/vars.ts";
import type { Scene } from "../src/types.ts";

const scene = (over: Partial<Scene>): Scene => ({ id: "s", durationPolicy: "auto", inputs: [], impl: { profile: "p", task: "t", params: {} }, produces: { video: "v.mp4" }, ...over });

describe("sceneDuration (spec §2.2)", () => {
  test("auto follows the media; exact follows the plan; min takes the longer", () => {
    expect(sceneDuration(scene({ duration: 5 }), 3)).toEqual({ duration: 3, estimated: false });
    expect(sceneDuration(scene({ duration: 5, durationPolicy: "exact" }), 3)).toEqual({ duration: 5, estimated: false });
    expect(sceneDuration(scene({ duration: 5, durationPolicy: "min" }), 3)).toEqual({ duration: 5, estimated: false });
    expect(sceneDuration(scene({ duration: 5, durationPolicy: "min" }), 8)).toEqual({ duration: 8, estimated: false });
  });
  test("missing media falls back to the plan and is flagged; image-only scenes are not estimates", () => {
    expect(sceneDuration(scene({ duration: 5 }), undefined)).toEqual({ duration: 5, estimated: true });
    expect(sceneDuration(scene({ duration: 5, produces: { image: "a.png" } }), undefined)).toEqual({ duration: 5, estimated: false });
  });
});

describe("SRT merge (spec §5)", () => {
  const srt = "1\n00:00:00,500 --> 00:00:01,000\nA\n\n2\n00:00:02,000 --> 00:00:03,000\nB\nsecond line\n\n3\n00:00:09,000 --> 00:00:10,000\nC\n";
  test("parses, shifts by scene start, clips to the scene window, drops cues outside it", () => {
    const cues = parseSrt(srt, "x.srt");
    expect(cues).toHaveLength(3);
    expect(cues[1]!.text).toBe("B\nsecond line");
    const merged = mergeCues([{ sceneId: "s1", cues, start: 10, end: 12.5 }]);
    expect(merged.cues).toEqual([
      { start: 10.5, end: 11, text: "A" },
      { start: 12, end: 12.5, text: "B\nsecond line" },
    ]);
    expect(merged.dropped.map((d) => d.cue.text)).toEqual(["C"]);
  });
  test("renumbers and sorts across scenes; round-trips through formatSrt", () => {
    const a = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nlate\n", "a");
    const b = parseSrt("1\n00:00:00,000 --> 00:00:00,500\nearly\n", "b");
    const merged = mergeCues([{ sceneId: "a", cues: a, start: 0, end: 5 }, { sceneId: "b", cues: b, start: 0.25, end: 5 }]);
    expect(formatSrt(merged.cues)).toBe("1\n00:00:00,250 --> 00:00:00,750\nearly\n\n2\n00:00:01,000 --> 00:00:02,000\nlate\n");
  });
  test("rejects malformed timing", () => {
    expect(() => parseSrt("1\n00:00 --> 00:01\nx\n", "bad.srt")).toThrow(/malformed SRT/);
  });
});

describe("${vars} substitution and argv templates", () => {
  test("substitutes scalars everywhere and leaves late placeholders only inside impl.params", () => {
    const r = substituteVars(
      { metadata: { title: "v${vars.n}" }, scenes: [{ impl: { params: { out: "${produces.video}", n: "${vars.n}" } }, intent: { caption: "${produces.video}" } }] },
      { n: 2 },
    );
    expect((r.value as { metadata: { title: string } }).metadata.title).toBe("v2");
    expect((r.value as { scenes: { impl: { params: Record<string, string> } }[] }).scenes[0]!.impl.params).toEqual({ out: "${produces.video}", n: "2" });
    expect(r.errors.map((e) => e.field)).toEqual(["scenes[0].intent.caption"]);
  });
  test("expandArgv splices arrays only as whole elements and resolves nested placeholders", () => {
    const r = expandArgv(["tool", "${params.args}", "--out=${produces.video}", "x${params.args}"], { "params.args": ["-a", "${node.id}"], "produces.video": "o.mp4", "node.id": "n1" }, "t");
    expect(r.argv).toEqual(["tool", "-a", "n1", "--out=o.mp4", "x${params.args}"]);
    expect(r.errors.map((e) => e.message)).toEqual(['array placeholder "${params.args}" must be a whole argv element']);
  });
});

describe("hashParams", () => {
  test("is independent of key order", () => {
    expect(hashParams({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashParams({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: 2 }));
  });
});
