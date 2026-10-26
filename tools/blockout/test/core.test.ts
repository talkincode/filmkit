// Dense time evaluation: the part of blockout that must be exactly right, because
// both engines are only appliers of what compileScene/evaluate return.

import { describe, expect, test } from "bun:test";
import {
  buildMesh,
  compileScene,
  evaluate,
  eulerToQuat,
  frameAtTime,
  freePropPose,
  humanoidRig,
  lowestZ,
  overviewCamera,
  overviewHelpers,
  qrotate,
  snapFrame,
  timeAtFrame,
  vlen,
  vsub,
  type BlockoutScene,
  type Vec3,
} from "../runtime/blockout-core.js";

function scene(over: Partial<BlockoutScene> = {}): BlockoutScene {
  return {
    apiVersion: "blockout/v1alpha1",
    kind: "BlockoutScene",
    id: "t",
    binding: { composition: { id: "c", revision: "r1" }, shot: { id: "s", revision: "r1" } },
    timing: { fps: 24, durationFrames: 48 },
    frame: { width: 320, height: 180 },
    environment: { floor: { size: [10, 10] } },
    subjects: [
      {
        id: "ann", binding: { id: "char-ann", revision: "r1" }, kind: "humanoid", height: 1.7,
        keyframes: [
          { frame: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
          { frame: 24, pos: [2.4, 0, 0] },
          { frame: 48, pos: [2.4, 4.8, 0], rot: [0, 0, 90] },
        ],
      },
    ],
    camera: { keyframes: [{ frame: 0, pos: [0, -6, 1.5], target: [0, 0, 1], focalLength: 35 }] },
    ...over,
  };
}

const compile = (s = scene()) => compileScene(s);
const near = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(eps));

describe("absolute time -> frame", () => {
  test("frame = time * fps, snapped so t = i/fps is exactly integer", () => {
    const c = compile();
    for (const fps of [24, 25, 30, 60, 23, 29, 119]) {
      const cc = { ...c, fps };
      for (let i = 0; i < 400; i++) expect(frameAtTime(cc, i / fps)).toBe(i);
    }
    expect(snapFrame(23.9999999999)).toBe(24);
    expect(snapFrame(23.4)).toBe(23.4);
    expect(timeAtFrame(c, 12)).toBe(0.5);
  });
});

describe("channels", () => {
  test("linear between keys, holds before the first and after the last", () => {
    const c = compile();
    expect(evaluate(c, 0).frames.ann!.root.pos).toEqual([0, 0, 0]);
    near(evaluate(c, 0.5).frames.ann!.root.pos, [1.2, 0, 0]); // frame 12, halfway to 2.4
    near(evaluate(c, 100).frames.ann!.root.pos, [2.4, 4.8, 0]); // far past the end
    near(evaluate(c, -3).frames.ann!.root.pos, [0, 0, 0]); // before the start
  });

  test("a channel keyed only in some keyframes interpolates across the keyframes that define it", () => {
    const c = compile();
    // rot is keyed at frames 0 and 48 only; frame 24 has no rot key but interpolates (0 -> 90)
    const q = evaluate(c, 1).frames.ann!.root.quat;
    near(q, eulerToQuat([0, 0, 45]));
  });

  test("hold keeps the left value until the next key; smooth eases with smoothstep", () => {
    const s = scene({
      subjects: [
        {
          id: "ann", binding: { id: "a", revision: "r1" }, kind: "capsule", height: 1.7,
          keyframes: [
            { frame: 0, pos: [0, 0, 0], interp: "hold" },
            { frame: 10, pos: [10, 0, 0], interp: "smooth" },
            { frame: 20, pos: [20, 0, 0] },
          ],
        },
      ],
    });
    const c = compile(s);
    const at = (f: number) => evaluate(c, f / 24).frames.ann!.root.pos[0]!;
    expect(at(9.999)).toBe(0); // hold
    expect(at(10)).toBe(10);
    // smooth segment 10..20: u=0.5 -> 0.5 exactly; u=0.25 -> 0.15625
    expect(at(15)).toBeCloseTo(15, 9);
    expect(at(12.5)).toBeCloseTo(10 + 10 * 0.15625, 9);
  });

  test("sub-frame times interpolate (time is absolute, not frame-quantized)", () => {
    const c = compile();
    const a = evaluate(c, 0.5).frames.ann!.root.pos[0]!;
    const b = evaluate(c, 0.5 + 1 / 48).frames.ann!.root.pos[0]!;
    expect(b - a).toBeCloseTo(0.05, 9); // half a frame at 0.1 m/frame
  });
});

describe("random seek returns the same state (the evaluator is stateless)", () => {
  test("shuffled evaluation equals sequential evaluation, byte for byte", () => {
    const c = compile();
    const frames = Array.from({ length: 48 }, (_, i) => i);
    const sequential = frames.map((f) => JSON.stringify(evaluate(c, f / 24)));
    // a fixed shuffle, plus repeats
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const order = [...frames, ...frames.slice(0, 20)].sort(() => rnd() - 0.5);
    for (const f of order) expect(JSON.stringify(evaluate(c, f / 24))).toBe(sequential[f % 48]!);
  });

  test("evaluation does not mutate the compiled scene", () => {
    const c = compile();
    const before = JSON.stringify(c);
    for (let i = 0; i < 20; i++) evaluate(c, i / 24);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("rotation conventions", () => {
  test("rot z = 90 turns a subject that faces +Y to face -X (counter-clockwise from above)", () => {
    near(qrotate(eulerToQuat([0, 0, 90]), [0, 1, 0]), [-1, 0, 0]);
  });

  test("Euler XYZ is extrinsic: X first, then Y, then Z about the fixed axes", () => {
    const v: Vec3 = [0, 1, 0];
    const q = eulerToQuat([90, 0, 90]);
    // X(90): +Y -> +Z; then Z(90): +Z stays +Z
    near(qrotate(q, v), [0, 0, 1]);
    near(qrotate(eulerToQuat([0, 90, 90]), [1, 0, 0]), [0, 0, -1]); // Y(90): +X -> -Z; Z leaves it
  });

  test("quaternions come out unit length with w >= 0", () => {
    const c = compile();
    for (let f = 0; f <= 48; f += 3) {
      const e = evaluate(c, f / 24);
      for (const p of [...Object.values(e.nodes), { quat: e.camera.quat }]) {
        expect(Math.hypot(...(p.quat as number[]))).toBeCloseTo(1, 9);
        expect(p.quat[3]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("humanoid joints", () => {
  test("at rest the feet touch the floor and the head tops out at the declared height", () => {
    const c = compile();
    const e = evaluate(c, 0);
    let lowest = Infinity;
    let highest = -Infinity;
    for (const n of c.nodes.filter((n) => n.group === "subject")) {
      const pose = e.nodes[n.id]!;
      lowest = Math.min(lowest, lowestZ(n.shape as never, pose));
      if (n.id.endsWith("/head")) highest = pose.pos[2] + (n.shape as { radius: number }).radius;
    }
    expect(lowest).toBeCloseTo(0, 6);
    expect(highest).toBeCloseTo(1.7, 2);
  });

  test("a joint rotation moves its hand point; positive X swings a hanging arm forward (+Y)", () => {
    const rest = evaluate(compile(), 0).frames.ann!.points.handR!.pos;
    const s = scene();
    s.subjects![0]!.keyframes[0]!.joints = { shoulderR: [90, 0, 0] };
    const raised = evaluate(compile(s), 0).frames.ann!.points.handR!.pos;
    // arm length (shoulder -> hand) = 0.36u; it now points along +Y from the shoulder
    const shoulder = evaluate(compile(s), 0).frames.ann!.joints.shoulderR!.pos;
    near(vsub(raised, shoulder), [0, 0.36 * 1.7, 0], 1e-6);
    expect(vlen(vsub(raised, rest))).toBeGreaterThan(0.5);
  });

  test("joint chains compose: the elbow rotates about the shoulder's rotated frame", () => {
    const s = scene();
    s.subjects![0]!.keyframes[0]!.joints = { shoulderR: [90, 0, 0], elbowR: [90, 0, 0] };
    const e = evaluate(compile(s), 0).frames.ann!;
    // upper arm points +Y, then the forearm turns a further 90 about X: it points +Z (up)
    near(vsub(e.points.handR!.pos, e.joints.elbowR!.pos), [0, 0, 0.17 * 1.7], 1e-6);
  });

  test("subject root rotation carries the whole body", () => {
    const e = evaluate(compile(), 2); // frame 48: rot z = 90, at (2.4, 4.8)
    const head = e.frames.ann!.points.head!.pos;
    near([head[0]!, head[1]!], [2.4, 4.8]);
    const nose = e.nodes["subject:ann/nose"]!.pos;
    expect(nose[0]).toBeLessThan(2.4); // faces -X
  });
});

describe("props: attach windows", () => {
  const withProp = (): BlockoutScene => {
    const s = scene();
    s.props = [
      {
        id: "mug", binding: { id: "p", revision: "r1" }, shape: { type: "cylinder", radius: 0.04, height: 0.1 },
        keyframes: [{ frame: 0, pos: [5, 5, 1] }],
        attach: [{ subject: "ann", joint: "handR", from: 10, to: 30 }],
      },
    ];
    return s;
  };

  test("free outside the window, glued to the hand inside it (inclusive bounds)", () => {
    const c = compile(withProp());
    const at = (f: number) => evaluate(c, f / 24);
    near(at(9).nodes["prop:mug"]!.pos, [5, 5, 1]);
    for (const f of [10, 20, 30]) {
      const e = at(f);
      near(e.nodes["prop:mug"]!.pos, e.frames.ann!.points.handR!.pos);
    }
    near(at(31).nodes["prop:mug"]!.pos, [5, 5, 1]);
  });

  test("the attach offset is expressed in the hand's frame", () => {
    const s = withProp();
    s.props![0]!.attach![0]!.offset = [0, 0, -0.1];
    const c = compile(s);
    const e = evaluate(c, 20 / 24);
    const hand = e.frames.ann!.points.handR!;
    near(e.nodes["prop:mug"]!.pos, [hand.pos[0] + 0, hand.pos[1], hand.pos[2] - 0.1], 1e-6); // arm at rest: hand frame == world axes
    expect(freePropPose(c, "mug", 20).pos).toEqual([5, 5, 1]);
  });
});

describe("camera", () => {
  test("looks at the target: forward axis (-Z local) points from pos to target", () => {
    const e = evaluate(compile(), 0);
    const fwd = qrotate(e.camera.quat, [0, 0, -1]);
    near(fwd, [0, 6 / Math.hypot(6, 0.5), -0.5 / Math.hypot(6, 0.5)], 1e-9);
    near([qrotate(e.camera.quat, [0, 1, 0])[0]!], [0]); // up stays in the plane of forward and world up
    expect(qrotate(e.camera.quat, [0, 1, 0])[2]).toBeGreaterThan(0.9);
  });

  test("focal length sets the vertical FOV for a horizontal sensor fit", () => {
    const e = evaluate(compile(), 0);
    // sensorWidth 36, 16:9, f = 35: fovY = 2 atan(36/(16/9)/2/35)
    const expected = (2 * Math.atan(36 / (320 / 180) / 2 / 35) * 180) / Math.PI;
    expect(e.camera.fovY).toBeCloseTo(expected, 5);
  });

  test("target and focal length are keyframed channels", () => {
    const s = scene({
      camera: {
        keyframes: [
          { frame: 0, pos: [0, -6, 1.5], target: [-2, 0, 1], focalLength: 24 },
          { frame: 24, pos: [0, -6, 1.5], target: [2, 0, 1], focalLength: 48 },
        ],
      },
    });
    const c = compile(s);
    const e = evaluate(c, 0.5); // frame 12
    near(e.camera.target, [0, 0, 1]);
    expect(e.camera.focalLength).toBeCloseTo(36, 9);
    // panning: forward turns from -x-ish to +x-ish through straight ahead
    expect(qrotate(evaluate(c, 0).camera.quat, [0, 0, -1])[0]).toBeLessThan(-0.1);
    expect(qrotate(evaluate(c, 1).camera.quat, [0, 0, -1])[0]).toBeGreaterThan(0.1);
  });

  test("looking straight along the up axis is an explicit error, not NaN", () => {
    const s = scene({ camera: { keyframes: [{ frame: 0, pos: [0, 0, 5], target: [0, 0, 0], focalLength: 35 }] } });
    expect(() => evaluate(compile(s), 0)).toThrow(/straight along the up axis/);
  });

  test("roll turns the image about the view axis", () => {
    const s = scene({ camera: { keyframes: [{ frame: 0, pos: [0, -6, 1], target: [0, 0, 1], focalLength: 35, roll: 90 }] } });
    const e = evaluate(compile(s), 0);
    near(qrotate(e.camera.quat, [0, 0, -1]), [0, 1, 0]); // forward unchanged
    expect(Math.abs(qrotate(e.camera.quat, [0, 1, 0])[2]!)).toBeLessThan(1e-9); // camera-up is now horizontal
  });
});

describe("meshes", () => {
  test("every shape is a closed, outward-wound surface", () => {
    for (const shape of [
      { type: "box", size: [1, 2, 3] },
      { type: "cylinder", radius: 0.5, height: 2 },
      { type: "sphere", radius: 0.5 },
      { type: "capsule", radius: 0.3, height: 1.7 },
    ] as const) {
      const m = buildMesh(shape as never);
      // closed 2-manifold: walking every face edge, each directed edge a>b occurs once and its
      // reverse b>a occurs once (checked by position: cap rims are duplicated vertices on purpose)
      const pk = (i: number) => m.positions[i]!.map((v) => v.toFixed(5)).join(",");
      const dir = new Map<string, number>();
      for (const f of m.faces) for (let i = 0; i < f.length; i++) {
        const a = pk(f[i]!);
        const b = pk(f[(i + 1) % f.length]!);
        if (a === b) continue;
        dir.set(`${a}>${b}`, (dir.get(`${a}>${b}`) ?? 0) + 1);
      }
      for (const [k, n] of dir) {
        const [a, b] = k.split(">");
        expect(n).toBe(1);
        expect(dir.get(`${b}>${a}`)).toBe(1); // the neighbouring face walks it back
      }
      // outward: signed volume is positive
      let vol = 0;
      for (const f of m.faces) for (let i = 1; i + 1 < f.length; i++) {
        const [p, q, r] = [m.positions[f[0]!]!, m.positions[f[i]!]!, m.positions[f[i + 1]!]!];
        vol += (p[0]! * (q[1]! * r[2]! - q[2]! * r[1]!) - p[1]! * (q[0]! * r[2]! - q[2]! * r[0]!) + p[2]! * (q[0]! * r[1]! - q[1]! * r[0]!)) / 6;
      }
      expect(vol).toBeGreaterThan(0);
    }
  });

  test("capsule height is the total height including both caps", () => {
    const m = buildMesh({ type: "capsule", radius: 0.3, height: 1.7 });
    const zs = m.positions.map((p) => p[2]!);
    expect(Math.max(...zs)).toBeCloseTo(0.85, 6);
    expect(Math.min(...zs)).toBeCloseTo(-0.85, 6);
  });

  test("the humanoid is built from the same capsules for any height", () => {
    const small = humanoidRig(1.0);
    const big = humanoidRig(2.0);
    expect(big.parts.length).toBe(small.parts.length);
    expect(big.parts[0]!.offset[2]).toBeCloseTo(2 * small.parts[0]!.offset[2], 9);
  });
});

describe("overview", () => {
  test("auto camera sees the whole floor and everything that moves, from in front and above", () => {
    const c = compile();
    const cam = overviewCamera(c);
    expect(cam.pos[2]).toBeGreaterThan(3);
    expect(cam.pos[1]).toBeLessThan(cam.target[1]); // in front of the scene (-Y side)
    // every floor corner and the end of ann's walk projects inside the frame
    const inv: [number, number, number, number] = [-cam.quat[0], -cam.quat[1], -cam.quat[2], cam.quat[3]];
    const tanH = Math.tan((cam.fovY * Math.PI) / 360);
    const tanW = tanH * (c.width / c.height);
    for (const p of [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0], [2.4, 4.8, 1.7]] as Vec3[]) {
      const local = qrotate(inv, vsub(p, cam.pos));
      const depth = -local[2];
      expect(depth).toBeGreaterThan(0);
      expect(Math.abs(local[0] / depth / tanW)).toBeLessThanOrEqual(1);
      expect(Math.abs(local[1] / depth / tanH)).toBeLessThanOrEqual(1);
    }
  });

  test("a declared overview camera is used as given", () => {
    const s = scene({ overview: { frame: 12, pos: [0, -20, 10], target: [0, 0, 0], focalLength: 50 } });
    const c = compile(s);
    const cam = overviewCamera(c);
    expect(cam.pos).toEqual([0, -20, 10]);
    expect(cam.focalLength).toBe(50);
    expect(c.overview.frame).toBe(12);
  });

  test("helpers: a ground path per subject, the camera path, start/end frusta", () => {
    const ids = overviewHelpers(compile()).map((n) => n.id);
    expect(ids).toEqual(["path:ann", "path:camera", "camera:start", "camera:end"]);
  });
});
