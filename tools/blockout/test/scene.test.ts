// A declaration is rejected before any engine runs, and the error says which field and which line.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { baseScene, cliJson, EXAMPLE, sandbox } from "./fixtures.ts";
import { loadScene, stillFrames } from "../src/scene.ts";
import { BlockoutError } from "../src/errors.ts";

const box = sandbox();
afterAll(() => box.cleanup());

async function errorsOf(scene: unknown, name = "s.json") {
  const r = await cliJson("validate", box.scene(name, scene));
  expect(r.exitCode).toBe(2);
  expect(r.out).toBeUndefined();
  return r.err!.errors;
}

describe("validate: the shipped example", () => {
  test("is valid, with stills at its declared frames", async () => {
    const r = await cliJson<{ ok: boolean; scene: { id: string }; stills: number[]; timing: { durationSeconds: number } }>("validate", EXAMPLE);
    expect(r.exitCode).toBe(0);
    expect(r.out!.ok).toBe(true);
    expect(r.out!.scene.id).toBe("counter-handoff");
    expect(r.out!.stills).toEqual([0, 8, 26, 55, 71]);
    expect(r.out!.timing.durationSeconds).toBe(3);
  });
});

describe("validate: structure (JSON Schema)", () => {
  test("unknown fields are rejected, with their field path and line", async () => {
    const text = JSON.stringify(baseScene(), null, 2).replace('"kind": "BlockoutScene"', '"kind": "BlockoutScene",\n  "bogus": 1');
    const errs = await errorsOf(text);
    const e = errs.find((x) => x.field === "bogus")!;
    expect(e.message).toContain('unknown field "bogus"');
    expect(e.line).toBe(4);
  });

  test("a missing binding revision is named at its path", async () => {
    const s = baseScene();
    delete (s.binding.composition as { revision?: string }).revision;
    const errs = await errorsOf(s);
    expect(errs.some((e) => e.field === "binding.composition.revision" && /missing required/.test(e.message))).toBe(true);
  });

  test("nested errors point into arrays", async () => {
    const s = baseScene();
    (s.subjects![0]!.keyframes[1] as { pos: unknown }).pos = [1, 2];
    const errs = await errorsOf(s);
    expect(errs[0]!.field).toBe("subjects[0].keyframes[1].pos");
    expect(errs[0]!.line).toBeGreaterThan(1);
  });

  test("odd frame sizes, fractional frames, and bad shapes fail", async () => {
    const s = baseScene();
    s.frame.width = 161;
    (s.timing as { durationFrames: number }).durationFrames = 24.5;
    (s.environment!.blocks![0] as { shape: unknown }).shape = { type: "torus", radius: 1 };
    const fields = (await errorsOf(s)).map((e) => e.field);
    expect(fields).toContain("frame.width");
    expect(fields).toContain("timing.durationFrames");
    expect(fields.some((f) => f?.startsWith("environment.blocks[0].shape"))).toBe(true);
  });

  test("invalid JSON reports line and column", async () => {
    const errs = await errorsOf('{\n  "apiVersion": "blockout/v1alpha1",\n  "kind": oops\n}');
    expect(errs[0]!.message).toContain("invalid JSON");
    expect(errs[0]!.line).toBe(3);
  });

  test("a file that does not exist is io (exit 1)", async () => {
    const r = await cliJson("validate", box.path("nope.json"));
    expect(r.exitCode).toBe(1);
    expect(r.err!.errors[0]!.code).toBe("io");
  });
});

describe("validate: meaning", () => {
  test("binding needs at least one of shot or scene; both are allowed", async () => {
    const s = baseScene();
    s.binding = { composition: { id: "c", revision: "1" } };
    expect((await errorsOf(s))[0]!.field).toBe("binding");
    s.binding = { composition: { id: "c", revision: "1" }, shot: { id: "a", revision: "1" }, scene: { id: "b", revision: "1" } };
    const ok = await cliJson("validate", box.scene("both.json", s));
    expect(ok.exitCode).toBe(0);
    s.binding = { composition: { id: "c", revision: "1" }, scene: { id: "b", revision: "1" } };
    expect((await cliJson("validate", box.scene("scene-only.json", s))).exitCode).toBe(0);
  });

  test("the environment binding is an id + revision pair and/or a variant, never half a pair or nothing", async () => {
    const s = baseScene();
    s.binding.environment = { id: "kitchen" };
    expect((await errorsOf(s))[0]!.field).toBe("binding.environment.revision");
    s.binding.environment = {};
    expect((await errorsOf(s, "e2.json"))[0]!.field).toBe("binding.environment");
    s.binding.environment = { variant: "day" };
    expect((await cliJson("validate", box.scene("e3.json", s))).exitCode).toBe(0);
    s.binding.environment = { id: "kitchen", revision: "2", variant: "night" };
    expect((await cliJson("validate", box.scene("e4.json", s))).exitCode).toBe(0);
  });

  test("subject and prop bindings may carry a variant; a variant with spaces is rejected", async () => {
    const s = baseScene();
    s.subjects![0]!.binding.variant = "with space";
    expect((await errorsOf(s))[0]!.field).toBe("subjects[0].binding.variant");
    s.subjects![0]!.binding.variant = "apron";
    expect((await cliJson("validate", box.scene("v.json", s))).exitCode).toBe(0);
  });

  test("ids are one namespace across walls, blocks, subjects and props", async () => {
    const s = baseScene();
    s.props = [{ id: "ann", binding: { id: "p", revision: "r1" }, shape: { type: "sphere", radius: 0.1 }, keyframes: [{ frame: 0, pos: [0, 0, 1] }] }];
    const e = (await errorsOf(s))[0]!;
    expect(e.message).toContain('duplicate id "ann"');
    expect(e.field).toBe("props[0].id");
  });

  test("keyframes past the last frame, or twice on one frame, are errors", async () => {
    const s = baseScene();
    s.subjects![0]!.keyframes.push({ frame: 99, pos: [0, 0, 0] }, { frame: 23, pos: [1, 1, 0] });
    const msgs = (await errorsOf(s)).map((e) => e.message);
    expect(msgs.some((m) => m.includes("past the last frame"))).toBe(true);
    expect(msgs.some((m) => m.includes("two keyframes on frame 23"))).toBe(true);
  });

  test("a subject, prop or camera that never sets pos/target/focalLength is rejected", async () => {
    const s = baseScene();
    s.subjects![0]!.keyframes = [{ frame: 0, rot: [0, 0, 0] }];
    s.camera.keyframes = [{ frame: 0, pos: [0, -5, 1] }];
    const msgs = (await errorsOf(s)).map((e) => e.message);
    expect(msgs.some((m) => m.includes('subject "ann" never sets "pos"'))).toBe(true);
    expect(msgs.some((m) => m.includes('never sets "target"'))).toBe(true);
    expect(msgs.some((m) => m.includes('never sets "focalLength"'))).toBe(true);
  });

  test("a capsule has no joints; attach needs a humanoid, a known joint and a non-empty, non-overlapping window", async () => {
    const s = baseScene();
    s.subjects!.push({ id: "cap", binding: { id: "c2", revision: "r1" }, kind: "capsule", height: 1.7, keyframes: [{ frame: 0, pos: [0, 0, 0], joints: { elbowR: [0, 0, 0] } }] });
    s.props = [{
      id: "mug", binding: { id: "p", revision: "r1" }, shape: { type: "cylinder", radius: 0.04, height: 0.1 }, keyframes: [{ frame: 0, pos: [0, 0, 1] }],
      attach: [
        { subject: "cap", joint: "handR", from: 0, to: 5 },
        { subject: "nobody", joint: "handR", from: 0, to: 5 },
        { subject: "ann", joint: "handR", from: 10, to: 4 },
        { subject: "ann", joint: "handR", from: 2, to: 8 },
        { subject: "ann", joint: "handL", from: 6, to: 9 },
      ],
    }];
    const msgs = (await errorsOf(s)).map((e) => `${e.field}: ${e.message}`).join("\n");
    expect(msgs).toContain("it has no joints");
    expect(msgs).toContain('only a humanoid has joints to hold a prop');
    expect(msgs).toContain('unknown subject "nobody"');
    expect(msgs).toContain("is empty");
    expect(msgs).toContain("overlap");
  });

  test("a camera that looks straight up or down is reported, not turned into NaN", async () => {
    const s = baseScene();
    s.camera.keyframes = [{ frame: 0, pos: [0, 0, 8], target: [0, 0, 0], focalLength: 35 }];
    const e = (await errorsOf(s))[0]!;
    expect(e.message).toContain("straight along the up axis");
    expect(e.field).toBe("camera.keyframes");
  });

  test("a camera that only becomes degenerate between keyframes is still caught", async () => {
    const s = baseScene({ timing: { fps: 24, durationFrames: 25 } });
    s.camera.keyframes = [
      { frame: 0, pos: [0, -5, 1], target: [0, 0, 1], focalLength: 35 },
      { frame: 12, pos: [0, 0, 8], target: [0, 0, 0], focalLength: 35, interp: "hold" },
      { frame: 24, pos: [0, -5, 1], target: [0, 0, 1], focalLength: 35 },
    ];
    expect((await errorsOf(s))[0]!.message).toContain("straight along the up axis");
  });

  test("stills must be unique and inside the clip; too many derived stills ask for an explicit list", () => {
    const s = baseScene();
    expect(stillFrames(s)).toEqual([0, 23]);
    s.subjects![0]!.keyframes = Array.from({ length: 40 }, (_, i) => ({ frame: i % 24, pos: [0, 0, 0] as [number, number, number] }));
    s.stills = undefined;
    // 24 distinct frames: fine
    expect(stillFrames(s).length).toBe(24);
    const big = baseScene({ timing: { fps: 24, durationFrames: 100 } });
    big.subjects![0]!.keyframes = Array.from({ length: 50 }, (_, i) => ({ frame: i * 2, pos: [0, 0, 0] as [number, number, number] }));
    expect(() => stillFrames(big)).toThrow(BlockoutError);
  });
});

describe("hand-off completeness (--handoff)", () => {
  test("the shipped example is complete: composition, shot AND scene, environment variant, a variant on everyone", async () => {
    const r = await cliJson<{ handoff: { complete: boolean; missing: string[] } }>("validate", EXAMPLE, "--handoff");
    expect(r.exitCode).toBe(0);
    expect(r.out!.handoff).toEqual({ complete: true, missing: [] });
  });

  test("a pure-geometry scene validates, reports what a hand-off would lack, and --handoff turns each gap into an error with its field", async () => {
    const path = box.scene("geometry-only.json", baseScene());
    const plain = await cliJson<{ handoff: { complete: boolean; missing: string[] } }>("validate", path);
    expect(plain.exitCode).toBe(0);
    expect(plain.out!.handoff).toEqual({
      complete: false,
      missing: ["binding.scene", "binding.environment.variant", "subjects[0].binding.variant"],
    });
    const strict = await cliJson("validate", path, "--handoff");
    expect(strict.exitCode).toBe(2);
    expect(strict.err!.errors.map((e) => e.field)).toEqual(plain.out!.handoff.missing);
    expect(strict.err!.errors[0]!.hint).toContain("composition, shot AND scene");
  });

  test("--handoff needs the random-seek check: --seek-samples 0 is refused before any work", async () => {
    const dest = box.path("handoff-noseek");
    const r = await cliJson("render", EXAMPLE, "--engine", "blender", "--out", dest, "--handoff", "--seek-samples", "0");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.field).toBe("--seek-samples");
    expect(existsSync(dest)).toBe(false);
  });

  test("render --handoff refuses before any work and creates nothing", async () => {
    const dest = box.path("handoff-out");
    const r = await cliJson("render", box.scene("g2.json", baseScene()), "--engine", "blender", "--out", dest, "--handoff");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors.length).toBe(3);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("loadScene", () => {
  test("pins the declaration's bytes (the sha256 in the manifest) and keeps them verbatim", () => {
    const l = loadScene(EXAMPLE);
    expect(l.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(EXAMPLE)).digest("hex"));
    expect(new TextDecoder().decode(l.bytes)).toBe(readFileSync(EXAMPLE, "utf8"));
  });
});
