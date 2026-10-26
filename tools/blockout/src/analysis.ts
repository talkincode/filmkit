// Facts derived from the declaration alone: what touches the floor, what is held,
// what hides behind what, what walks through a wall. Both engines render the same
// declaration, so this is engine-independent and goes into the manifest verbatim.
//
// Geometry here is deliberately coarse and says so: occluders and obstacles are
// tested by their oriented bounding boxes (exact for boxes and walls, conservative
// for cylinders, spheres and capsules). It is white-model blocking evidence, not a
// physics simulation.

import {
  evaluate,
  lowestZ,
  qrotate,
  shapeHalfExtents,
  timeAtFrame,
  vlen,
  vsub,
  type CompiledScene,
  type Evaluated,
  type Quat,
  type Shape,
  type Vec3,
} from "../runtime/blockout-core.js";

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** Within this of z = 0 (meters) counts as touching the floor: a walking figure lifts a few centimeters at mid-stride. */
export const GROUND_TOLERANCE = 0.05;
/** A prop that moves more than this between two frames at a hold/release has teleported. */
export const TELEPORT_METERS = 0.25;

export interface Range { from: number; to: number }

export interface Analysis {
  groundContact: { id: string; kind: "subject" | "prop"; lowestZ: { min: number; max: number }; groundedFrames: number; airborneFrames: number; belowFloorFrames: number }[];
  attachments: { prop: string; subject: string; joint: string; from: number; to: number; entryJump: number | null; exitJump: number | null; teleport: boolean }[];
  occlusions: ({ subject: string; state: "partial" | "occluded"; by: string[] } & Range)[];
  framing: ({ subject: string; state: "offscreen" } & Range)[];
  penetrations: ({ subject: string; with: string } & Range)[];
  warnings: string[];
}

interface Obb { id: string; center: Vec3; quat: Quat; half: Vec3 }

function occluders(c: CompiledScene): Obb[] {
  return c.nodes
    .filter((n) => n.group === "environment" && n.id !== "floor" && n.static && n.shape.type !== "mesh")
    .map((n) => ({ id: n.ref!, center: n.static!.pos, quat: n.static!.quat, half: shapeHalfExtents(n.shape as Shape) }));
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Does the segment a->b pass through the box? (slab test in the box's own frame) */
function segmentHitsObb(a: Vec3, b: Vec3, box: Obb): boolean {
  const inv = conj(box.quat);
  const la = qrotate(inv, vsub(a, box.center));
  const lb = qrotate(inv, vsub(b, box.center));
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = lb[i]! - la[i]!;
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(la[i]!) > box.half[i]!) return false;
      continue;
    }
    let ta = (-box.half[i]! - la[i]!) / d;
    let tb = (box.half[i]! - la[i]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** Points on a subject that stand for "is this person visible": head, torso, pelvis. */
function samplePoints(c: CompiledScene, e: Evaluated, id: string): Vec3[] {
  const sub = c.subjects.find((s) => s.id === id)!;
  if (sub.rig) {
    return [e.nodes[`subject:${id}/head`]!.pos, e.nodes[`subject:${id}/torso`]!.pos, e.frames[id]!.joints.hipL!.pos];
  }
  const root = e.frames[id]!.root.pos;
  return [0.85, 0.5, 0.2].map((k) => [root[0], root[1], root[2] + k * sub.height] as Vec3);
}

/** Camera-space depth and normalized image coordinates of a world point. */
function project(c: CompiledScene, e: Evaluated, p: Vec3): { depth: number; x: number; y: number } {
  const rel = vsub(p, e.camera.pos);
  const local = qrotate(conj(e.camera.quat), rel);
  const depth = -local[2];
  const halfH = Math.tan((e.camera.fovY * Math.PI) / 360);
  const halfW = halfH * (c.width / c.height);
  return { depth, x: local[0] / (depth * halfW), y: local[1] / (depth * halfH) };
}

/** Run-length encode a per-frame label into [from, to] ranges. */
function runs<T>(labels: (T | null)[], same: (a: T, b: T) => boolean): { value: T; from: number; to: number }[] {
  const out: { value: T; from: number; to: number }[] = [];
  labels.forEach((v, f) => {
    if (v === null) return;
    const prev = out[out.length - 1];
    if (prev && prev.to === f - 1 && same(prev.value, v)) prev.to = f;
    else out.push({ value: v, from: f, to: f });
  });
  return out;
}

export function analyze(c: CompiledScene): Analysis {
  const frames = Array.from({ length: c.durationFrames }, (_, f) => f);
  const states = frames.map((f) => evaluate(c, timeAtFrame(c, f)));
  const boxes = occluders(c);
  const warnings: string[] = [];

  // ground contact
  const groundContact: Analysis["groundContact"] = [];
  for (const sub of c.subjects) {
    const parts = c.nodes.filter((n) => n.group === "subject" && n.ref === sub.id);
    const lows = states.map((e) => Math.min(...parts.map((n) => lowestZ(n.shape as Shape, e.nodes[n.id]!))));
    groundContact.push(contact(sub.id, "subject", lows));
  }
  for (const prop of c.props) {
    const lows = states.map((e) => lowestZ(prop.shape, e.nodes[`prop:${prop.id}`]!));
    groundContact.push(contact(prop.id, "prop", lows));
  }

  // attachments: how big is the jump where the rule that places the prop changes?
  const attachments: Analysis["attachments"] = [];
  for (const prop of c.props) {
    const pos = (f: number) => states[f]!.nodes[`prop:${prop.id}`]!.pos;
    for (const a of prop.attach) {
      const entryJump = a.from > 0 ? r4(vlen(vsub(pos(a.from), pos(a.from - 1)))) : null;
      const exitJump = a.to < c.durationFrames - 1 ? r4(vlen(vsub(pos(a.to + 1), pos(a.to)))) : null;
      const teleport = (entryJump ?? 0) > TELEPORT_METERS || (exitJump ?? 0) > TELEPORT_METERS;
      if (teleport) warnings.push(`prop "${prop.id}" jumps ${Math.max(entryJump ?? 0, exitJump ?? 0)} m where it is picked up or released (attach ${a.subject}.${a.joint} frames ${a.from}-${a.to})`);
      attachments.push({ prop: prop.id, subject: a.subject, joint: a.joint, from: a.from, to: a.to, entryJump, exitJump, teleport });
    }
  }

  // occlusion + framing
  const occlusions: Analysis["occlusions"] = [];
  const framing: Analysis["framing"] = [];
  for (const sub of c.subjects) {
    const perFrame = states.map((e) => {
      const points = samplePoints(c, e, sub.id);
      const hits = points.map((p) => boxes.filter((b) => segmentHitsObb(e.camera.pos, p, b)).map((b) => b.id));
      const visible = hits.filter((h) => h.length === 0).length;
      const by = [...new Set(hits.flat())].sort();
      const proj = project(c, e, points[1]!);
      const offscreen = proj.depth <= 0.05 || Math.abs(proj.x) > 1 || Math.abs(proj.y) > 1;
      return { visible, by, offscreen };
    });
    for (const r of runs(perFrame.map((p) => (p.visible === 3 ? null : { state: p.visible === 0 ? "occluded" : "partial", by: p.by.join(",") })), (a, b) => a.state === b.state && a.by === b.by)) {
      occlusions.push({ subject: sub.id, state: r.value.state as "partial" | "occluded", by: r.value.by.split(","), from: r.from, to: r.to });
    }
    for (const r of runs(perFrame.map((p) => (p.offscreen ? ("offscreen" as const) : null)), (a, b) => a === b)) {
      framing.push({ subject: sub.id, state: "offscreen", from: r.from, to: r.to });
    }
  }

  // subjects walking through solid set pieces (footprint circle against the box bounds)
  const penetrations: Analysis["penetrations"] = [];
  for (const sub of c.subjects) {
    const radius = sub.rig ? 0.18 * sub.height : (c.nodes.find((n) => n.id === `subject:${sub.id}/body`)!.shape as { radius: number }).radius;
    for (const box of boxes) {
      const hit = states.map((e) => {
        const root = e.frames[sub.id]!.root.pos;
        const local = qrotate(conj(box.quat), vsub(root, box.center));
        const dx = Math.max(Math.abs(local[0]) - box.half[0], 0);
        const dy = Math.max(Math.abs(local[1]) - box.half[1], 0);
        const overlapsHeight = box.center[2] + box.half[2] > root[2] && box.center[2] - box.half[2] < root[2] + sub.height;
        return overlapsHeight && Math.hypot(dx, dy) < radius ? true : null;
      });
      for (const r of runs(hit, () => true)) penetrations.push({ subject: sub.id, with: box.id, from: r.from, to: r.to });
    }
  }
  for (const p of penetrations) warnings.push(`subject "${p.subject}" is inside "${p.with}" on frames ${p.from}-${p.to}`);
  for (const g of groundContact) {
    if (g.belowFloorFrames) warnings.push(`${g.kind} "${g.id}" is below the floor on ${g.belowFloorFrames} frame(s)`);
  }

  return { groundContact, attachments, occlusions, framing, penetrations, warnings };
}

function contact(id: string, kind: "subject" | "prop", lows: number[]) {
  return {
    id, kind,
    lowestZ: { min: r4(Math.min(...lows)), max: r4(Math.max(...lows)) },
    groundedFrames: lows.filter((z) => Math.abs(z) <= GROUND_TOLERANCE).length,
    airborneFrames: lows.filter((z) => z > GROUND_TOLERANCE).length,
    belowFloorFrames: lows.filter((z) => z < -GROUND_TOLERANCE).length,
  };
}
