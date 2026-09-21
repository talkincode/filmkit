// Pure-function tests for the pieces whose correctness is easiest to pin down
// without ffmpeg: timeline arithmetic, SRT merge, substitution, hashing.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSrt, mergeCues, parseSrt } from "../src/build/subtitles.ts";
import { paramsHash } from "../src/hash.ts";
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

describe("argv templates: optional placeholders", () => {
  test("drops the whole element when an optional placeholder is absent, keeps it otherwise", () => {
    const t = ["tool", "run", "${params.entry}", "--crf=${params.crf?}", "--scale=${params.scale?}", "${params.frames?}"];
    const base = { "params.entry": "src/index.ts" };
    expect(expandArgv(t, base, "x").argv).toEqual(["tool", "run", "src/index.ts"]);
    expect(expandArgv(t, { ...base, "params.crf": "18" }, "x").argv).toEqual(["tool", "run", "src/index.ts", "--crf=18"]);
    expect(expandArgv(t, { ...base, "params.crf": "18", "params.frames": "0-89" }, "x").argv).toEqual([
      "tool", "run", "src/index.ts", "--crf=18", "0-89",
    ]);
  });

  test("a required placeholder that is absent is still an error", () => {
    const r = expandArgv(["tool", "${params.nope}"], {}, "x");
    expect(r.argv).toEqual(["tool", "${params.nope}"]);
    expect(r.errors.map((e) => e.message)).toEqual(['unknown placeholder "${params.nope}"']);
  });

  test("a misspelled optional param name is caught against the declared schema keys", () => {
    const r = expandArgv(["tool", "--crf=${params.crf?}"], { "params.crf": "18" }, "x", ["codec", "crf"]);
    expect(r.argv).toEqual(["tool", "--crf=18"]);
    const bad = expandArgv(["tool", "--coodec=${params.coodec?}"], {}, "x", ["codec", "crf"]);
    expect(bad.errors.map((e) => e.message)).toEqual(["params.coodec is not declared in the task's paramsSchema"]);
    const malformed = expandArgv(["tool", "--x=${params.a b?}"], {}, "x", ["codec"]);
    expect(malformed.errors.map((e) => e.message)).toEqual(['malformed placeholder name "params.a b"']);
  });
});

describe("paramsHash", () => {
  test("is independent of key order", () => {
    expect(paramsHash({ a: 1, b: { c: [1, 2], d: "x" } }, "/tmp")).toBe(paramsHash({ b: { d: "x", c: [1, 2] }, a: 1 }, "/tmp"));
    expect(paramsHash({ a: 1 }, "/tmp")).not.toBe(paramsHash({ a: 2 }, "/tmp"));
  });

  test("follows the content of referenced files and directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "filmkit-hash-"));
    try {
      writeFileSync(join(dir, "doc.yaml"), "a: 1\n");
      mkdirSync(join(dir, "project/src"), { recursive: true });
      writeFileSync(join(dir, "project/src/index.tsx"), "export const A = 1;\n");
      mkdirSync(join(dir, "project/node_modules/dep"), { recursive: true });
      writeFileSync(join(dir, "project/node_modules/dep/index.js"), "module.exports = 1;\n");
      const params = { doc: "./doc.yaml", project: "./project" };
      const base = paramsHash(params, dir);
      expect(base).toBe(paramsHash({ doc: "./doc.yaml", project: "./project" }, dir));

      // Editing the tool's own document changes the hash…
      writeFileSync(join(dir, "doc.yaml"), "a: 2\n");
      expect(paramsHash(params, dir)).not.toBe(base);
      writeFileSync(join(dir, "doc.yaml"), "a: 1\n");
      // …as does adding a source file inside a referenced project directory…
      expect(paramsHash(params, dir)).toBe(base);
      writeFileSync(join(dir, "project/src/new.tsx"), "export const B = 2;\n");
      const withNew = paramsHash(params, dir);
      expect(withNew).not.toBe(base);
      // …but node_modules is tooling, not source.
      writeFileSync(join(dir, "project/node_modules/dep/index.js"), "module.exports = 2;\n");
      expect(paramsHash(params, dir)).toBe(withNew);
      // A path that does not exist yet hashes differently from one that does.
      expect(paramsHash({ doc: "./nope.yaml" }, dir)).not.toBe(paramsHash({ doc: "./doc.yaml" }, dir));
      // Absolute paths and plain values are not treated as project paths.
      expect(paramsHash({ abs: "/etc/hosts" }, dir)).toBe(paramsHash({ abs: "/etc/hosts" }, dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
