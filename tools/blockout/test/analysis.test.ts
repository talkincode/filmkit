// Contact and blocking facts derived from the declaration (no engine involved).

import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analysis.ts";
import { compileScene, evaluate, type BlockoutScene } from "../runtime/blockout-core.js";
import { baseScene, EXAMPLE } from "./fixtures.ts";
import { loadScene } from "../src/scene.ts";

const run = (s: BlockoutScene) => analyze(compileScene(s));

describe("occlusion", () => {
  test("a subject walking behind a wall is occluded exactly while the wall is between it and the camera", () => {
    // camera at (0,-6,1.6); the wall spans x in [-1,1] at y=-1; ann walks along y=1 from x=-3 to x=3
    const a = run(baseScene());
    const occ = a.occlusions.filter((o) => o.subject === "ann");
    expect(occ.length).toBeGreaterThan(0);
    for (const o of occ) expect(o.by).toEqual(["wall"]);
    // the ray from the camera to ann's torso crosses y=-1 at 5/7 of the way: |x| < 1 there <=> |ann.x| < 1.4 (approx, +/- body)
    const first = occ[0]!;
    const full = occ.find((o) => o.state === "occluded")!;
    // ann moves 6 m over 23 frames: x(f) = -3 + 6f/23; hidden around x = 0, i.e. frame ~11.5
    expect(full.from).toBeLessThanOrEqual(11);
    expect(full.to).toBeGreaterThanOrEqual(12);
    expect(first.from).toBeGreaterThan(2);
    expect(occ[occ.length - 1]!.to).toBeLessThan(22);
  });

  test("moving the wall away removes the occlusion", () => {
    const s = baseScene();
    s.environment!.blocks![0]!.pos = [0, 4, 1]; // behind ann, not between her and the camera
    expect(run(s).occlusions).toEqual([]);
  });

  test("subjects outside the camera's view are reported as offscreen", () => {
    const s = baseScene();
    s.camera.keyframes[0]!.target = [-8, 0, 1.2]; // look far left of the action
    const a = run(s);
    expect(a.framing.some((f) => f.subject === "ann" && f.state === "offscreen")).toBe(true);
  });

  test("the shipped example: ann hides behind the partition on frames 31-44, ben starts off screen", () => {
    const a = analyze(loadScene(EXAMPLE).compiled);
    expect(a.occlusions).toEqual([{ subject: "ann", state: "occluded", by: ["partition"], from: 31, to: 44 }]);
    expect(a.framing).toEqual([{ subject: "ben", state: "offscreen", from: 0, to: 28 }]);
  });
});

describe("ground contact", () => {
  test("standing subjects touch the floor on every frame", () => {
    const g = run(baseScene()).groundContact.find((x) => x.id === "ann")!;
    expect(g.groundedFrames).toBe(24);
    expect(g.airborneFrames).toBe(0);
    expect(g.lowestZ.min).toBeCloseTo(0, 3);
  });

  test("a jump shows up as airborne frames; sinking below the floor is flagged", () => {
    const s = baseScene();
    s.subjects![0]!.keyframes = [
      { frame: 0, pos: [0, 1, 0] },
      { frame: 12, pos: [0, 1, 0.8] },
      { frame: 23, pos: [0, 1, -0.3] },
    ];
    const a = run(s);
    const g = a.groundContact.find((x) => x.id === "ann")!;
    expect(g.airborneFrames).toBeGreaterThan(5);
    expect(g.belowFloorFrames).toBeGreaterThan(0);
    expect(a.warnings.some((w) => w.includes('subject "ann" is below the floor'))).toBe(true);
  });
});

describe("held props", () => {
  const withMug = (attach: { from: number; to: number }, freeAt: [number, number, number]): BlockoutScene => {
    const s = baseScene();
    s.props = [{
      id: "mug", binding: { id: "p", revision: "r1" }, shape: { type: "cylinder", radius: 0.04, height: 0.1 },
      keyframes: [{ frame: 0, pos: freeAt }],
      attach: [{ subject: "ann", joint: "handR", ...attach }],
    }];
    return s;
  };

  test("a prop that is already in the hand when the window opens has no jump; one that was across the room teleports and is flagged", () => {
    const handAt4 = evaluate(compileScene(baseScene()), 4 / 24).frames.ann!.points.handR!.pos;
    const inHand = run(withMug({ from: 4, to: 23 }, handAt4)).attachments[0]!;
    expect(inHand.entryJump!).toBeLessThan(0.05); // one frame of walking, not a teleport
    expect(inHand.exitJump).toBeNull(); // held to the end of the clip
    expect(inHand.teleport).toBe(false);
    // released mid-walk with no keyframe for where it lands: it snaps back to where it started
    expect(run(withMug({ from: 4, to: 10 }, handAt4)).attachments[0]!.exitJump!).toBeGreaterThan(1);
    const far = run(withMug({ from: 4, to: 10 }, [5, 5, 1]));
    expect(far.attachments[0]!.teleport).toBe(true);
    expect(far.attachments[0]!.entryJump!).toBeGreaterThan(1);
    expect(far.attachments[0]!.exitJump!).toBeGreaterThan(1);
    expect(far.warnings.some((w) => w.includes('prop "mug" jumps'))).toBe(true);
  });

  test("windows at the clip's edges have null jumps on that side", () => {
    const a = run(withMug({ from: 0, to: 23 }, [0, 0, 1])).attachments[0]!;
    expect(a.entryJump).toBeNull();
    expect(a.exitJump).toBeNull();
    expect(a.teleport).toBe(false);
  });

  test("the shipped example hands the mug over smoothly", () => {
    const a = analyze(loadScene(EXAMPLE).compiled);
    expect(a.attachments.map((x) => [x.subject, x.from, x.to, x.teleport])).toEqual([["ann", 8, 55, false], ["ben", 56, 71, false]]);
    expect(a.attachments[0]!.entryJump!).toBeLessThan(0.01);
    expect(a.attachments[1]!.entryJump!).toBeLessThan(0.1);
    expect(a.warnings).toEqual([]);
  });
});

describe("penetrations", () => {
  test("walking through a solid set piece is reported with the frames", () => {
    const s = baseScene();
    s.environment!.blocks![0]!.pos = [0, 1, 1]; // right on ann's path
    const p = run(s).penetrations;
    expect(p.length).toBe(1);
    expect(p[0]!.with).toBe("wall");
    expect(p[0]!.from).toBeGreaterThan(5);
    expect(p[0]!.to).toBeLessThan(18);
  });

  test("walking around it is fine", () => {
    expect(run(baseScene()).penetrations).toEqual([]);
  });
});

describe("determinism", () => {
  test("the same declaration gives the same analysis, byte for byte", () => {
    const l = loadScene(EXAMPLE);
    expect(JSON.stringify(analyze(l.compiled))).toBe(JSON.stringify(analyze(l.compiled)));
  });
});
