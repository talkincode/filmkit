// Blender takes no part in evaluating the scene. This module runs the shared
// evaluator once per frame and writes what Blender needs as plain numbers: meshes,
// colors, and a (position, quaternion) per animated node per frame. The Python
// that runs inside Blender only creates objects and keys what it is told.

import { createHash } from "node:crypto";
import {
  evaluate,
  meshForShape,
  overviewCamera,
  overviewHelpers,
  timeAtFrame,
  type CompiledNode,
  type Pose,
  type RawMesh,
} from "../../runtime/blockout-core.js";
import type { LoadedScene } from "../scene.ts";

export const BAKE_PROTOCOL = "blockout-bake/v1alpha1";

type Row = [number, number, number, number, number, number, number];

export interface Bake {
  protocol: typeof BAKE_PROTOCOL;
  scene: { id: string; sha256: string };
  fps: number;
  durationFrames: number;
  width: number;
  height: number;
  /** Linear RGB, as Blender wants it. */
  background: [number, number, number];
  sensorWidth: number;
  overview: { frame: number; pos: number[]; quat: number[]; focalLength: number };
  meshes: Record<string, RawMesh>;
  nodes: { id: string; group: string; mesh: string; color: [number, number, number, number]; static?: Pose; overviewOnly?: boolean }[];
  /** node id -> one [x,y,z, qx,qy,qz,qw] per frame, frame 0 first. */
  frames: Record<string, Row[]>;
  /** One [x,y,z, qx,qy,qz,qw, focalLength] per frame. */
  camera: [...Row, number][];
}

/** "#rrggbb" (sRGB) -> linear RGB. Three.js converts the same way, so both engines see the same color. */
export function hexToLinear(hex: string): [number, number, number] {
  const c = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [c(0), c(1), c(2)];
}

const round = (n: number) => Math.round(n * 1e7) / 1e7;
const row = (p: Pose): Row => [...p.pos, ...p.quat].map(round) as Row;

export function bake(loaded: LoadedScene): Bake {
  const c = loaded.compiled;
  const meshes: Record<string, RawMesh> = {};
  const keyOf = new Map<string, string>();
  const meshKey = (shape: CompiledNode["shape"]): string => {
    const json = JSON.stringify(shape);
    let key = keyOf.get(json);
    if (!key) {
      key = `m${keyOf.size}-${createHash("sha256").update(json).digest("hex").slice(0, 8)}`;
      keyOf.set(json, key);
      meshes[key] = meshForShape(shape);
    }
    return key;
  };

  const all = [...c.nodes.map((n) => ({ n, overviewOnly: false })), ...overviewHelpers(c).map((n) => ({ n, overviewOnly: true }))];
  const nodes = all.map(({ n, overviewOnly }) => ({
    id: n.id,
    group: n.group,
    mesh: meshKey(n.shape),
    color: [...hexToLinear(n.color).map(round), 1] as [number, number, number, number],
    ...(n.static ? { static: { pos: n.static.pos, quat: n.static.quat } } : {}),
    ...(overviewOnly ? { overviewOnly: true } : {}),
  }));

  const frames: Record<string, Row[]> = {};
  const camera: Bake["camera"] = [];
  for (let f = 0; f < c.durationFrames; f++) {
    const e = evaluate(c, timeAtFrame(c, f));
    for (const [id, pose] of Object.entries(e.nodes)) (frames[id] ??= []).push(row(pose));
    camera.push([...row({ pos: e.camera.pos, quat: e.camera.quat }), round(e.camera.focalLength)]);
  }

  const ov = overviewCamera(c);
  return {
    protocol: BAKE_PROTOCOL,
    scene: { id: c.id, sha256: loaded.sha256 },
    fps: c.fps,
    durationFrames: c.durationFrames,
    width: c.width,
    height: c.height,
    background: hexToLinear(c.background).map(round) as [number, number, number],
    sensorWidth: c.camera.sensorWidth,
    overview: { frame: c.overview.frame, pos: ov.pos.map(round), quat: ov.quat.map(round), focalLength: ov.focalLength },
    meshes,
    nodes,
    frames,
    camera,
  };
}
