// blockout-core — the one place that knows what a blockout scene MEANS.
//
// It is deliberately a dependency-free ES module, written in plain JavaScript:
//   * the Bun tool imports it (validation, analysis, baking for Blender);
//   * the Three.js/HyperFrames project ships a byte-for-byte copy of it and
//     imports it in the browser at seek time.
// Both engines therefore evaluate the same declaration with the same code. An
// engine only *applies* what this module returns; it never interpolates, never
// walks a skeleton, never converts a convention.
//
// Conventions (also in README.md):
//   * World: right-handed, Z up, meters. +X right, +Y forward, +Z up.
//   * Rotations are degrees, Euler XYZ in the extrinsic sense (rotate about the
//     parent's X, then Y, then Z), i.e. R = Rz * Ry * Rx. Quaternions are [x,y,z,w].
//   * A subject at rot [0,0,0] faces +Y. Its own axes: x = right, y = forward, z = up.
//   * Time is absolute seconds; frame = time * fps. Keyframes sit on integer
//     frames. The evaluator is a pure function of (scene, time): no state, no
//     clock, no randomness, so seeking anywhere gives the same answer.
//   * Camera: looks down its local -Z with +Y up (the Blender and Three.js
//     convention), built from pos + target + roll. The sensor fit is horizontal.

export const PROTOCOL = "blockout/v1alpha1";

export const JOINTS = ["spine", "neck", "shoulderL", "shoulderR", "elbowL", "elbowR", "hipL", "hipR", "kneeL", "kneeR"];
/** Points a prop can be attached to (humanoid only). Joints themselves are valid too. */
export const ATTACH_POINTS = [...JOINTS, "handL", "handR", "head"];
export const SHAPE_TYPES = ["box", "cylinder", "sphere", "capsule"];
export const INTERPS = ["linear", "hold", "smooth"];

const DEG = Math.PI / 180;
const UP = [0, 0, 1];
const IDENTITY_Q = [0, 0, 0, 1];
/** Round to 1e-6 so engines and CPUs agree on the last bit of trig. */
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ───────────────────────── vectors and quaternions ─────────────────────────

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qrotate(q, v) {
  const t = scale(cross([q[0], q[1], q[2]], v), 2);
  return add(add(v, scale(t, q[3])), cross([q[0], q[1], q[2]], t));
}

function qaxis(axis, deg) {
  const h = (deg * DEG) / 2;
  const q = [0, 0, 0, Math.cos(h)];
  q[axis] = Math.sin(h);
  return q;
}

/** Degrees [rx, ry, rz] -> quaternion for R = Rz * Ry * Rx. */
export function eulerToQuat(rot) {
  return qmul(qaxis(2, rot[2]), qmul(qaxis(1, rot[1]), qaxis(0, rot[0])));
}

/** Rotation matrix with columns x, y, z -> quaternion (Shepperd). */
function basisToQuat(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return q;
}

/** Unit length, and a canonical sign (w >= 0) so the same rotation always prints the same. */
function canon(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  let o = [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  const flip = o[3] < 0 || (o[3] === 0 && (o[0] < 0 || (o[0] === 0 && (o[1] < 0 || (o[1] === 0 && o[2] < 0)))));
  if (flip) o = [-o[0], -o[1], -o[2], -o[3]];
  return o.map((v) => (Object.is(v, -0) ? 0 : v));
}

function compose(parent, localPos, localQuat) {
  return { pos: add(parent.pos, qrotate(parent.quat, localPos)), quat: qmul(parent.quat, localQuat) };
}

// ───────────────────────── keyframe channels ─────────────────────────

/** frame*fps jitter (t = i/fps) must not turn an integer frame into 23.999999999. */
export function snapFrame(f) {
  const r = Math.round(f);
  return Math.abs(f - r) < 1e-9 ? r : f;
}

export function frameAtTime(c, t) {
  return snapFrame(t * c.fps);
}

export function timeAtFrame(c, f) {
  return f / c.fps;
}

const smoothstep = (u) => u * u * (3 - 2 * u);

/** keys: [{frame, value:number[], interp}] sorted by frame, frames unique. */
function sampleKeys(keys, f) {
  const first = keys[0];
  if (f <= first.frame) return first.value;
  const last = keys[keys.length - 1];
  if (f >= last.frame) return last.value;
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= f) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  if (a.interp === "hold") return a.value;
  let u = (f - a.frame) / (b.frame - a.frame);
  if (a.interp === "smooth") u = smoothstep(u);
  return a.value.map((v, i) => v + (b.value[i] - v) * u);
}

/** Collect one channel's keys from a keyframe list. `pick` returns the value or undefined. */
function collect(keyframes, pick) {
  const keys = [];
  for (const k of keyframes) {
    const v = pick(k);
    if (v !== undefined) keys.push({ frame: k.frame, value: Array.isArray(v) ? v : [v], interp: k.interp ?? "linear" });
  }
  keys.sort((a, b) => a.frame - b.frame);
  return keys.length ? keys : null;
}

// ───────────────────────── shapes and meshes ─────────────────────────

/** Surface of revolution around Z. ring: [radius, z]; equal consecutive rings mark a hard edge. */
function lathe(rings, segments) {
  const positions = [];
  const ringStart = [];
  for (const [r, z] of rings) {
    ringStart.push(positions.length);
    if (r === 0) positions.push([0, 0, z]);
    else for (let s = 0; s < segments; s++) {
      const a = (s / segments) * 2 * Math.PI;
      positions.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
  }
  const faces = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const [r0, z0] = rings[i];
    const [r1, z1] = rings[i + 1];
    if (r0 === r1 && z0 === z1) continue; // duplicated ring = hard edge, no surface between
    const a = ringStart[i];
    const b = ringStart[i + 1];
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      if (r0 === 0) faces.push([a, b + s, b + n]);
      else if (r1 === 0) faces.push([a + s, b, a + n]);
      else faces.push([a + s, b + s, b + n, a + n]);
    }
  }
  return { positions, faces };
}

function orientFaces(mesh) {
  // lathe builds rings bottom -> top, which winds faces toward the axis; flip so normals face out.
  return { ...mesh, faces: mesh.faces.map((f) => [...f].reverse()) };
}

function hemisphereRings(radius, centerZ, up, steps) {
  const rings = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    // up: from the equator (a = 0) to the pole; down: from the pole to the equator
    rings.push([Math.cos(a) * radius, centerZ + (up ? 1 : -1) * Math.sin(a) * radius]);
  }
  return up ? rings : rings.reverse();
}

/**
 * Shape recipe -> { positions: [[x,y,z]], faces: [[i,i,i(,i)]], smooth }.
 * Local frame is Z-up and the shape is centered on its origin.
 */
export function buildMesh(shape) {
  switch (shape.type) {
    case "box": {
      const [hx, hy, hz] = shape.size.map((v) => v / 2);
      const positions = [
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
      ];
      const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      return { positions: positions.map((p) => p.map(r6)), faces, smooth: false };
    }
    case "cylinder": {
      const h = shape.height / 2;
      const r = shape.radius;
      // rim rings are duplicated so the caps stay flat while the side shades smooth
      const mesh = lathe([[0, -h], [r, -h], [r, -h], [r, h], [r, h], [0, h]], 24);
      return finish(orientFaces(mesh), true);
    }
    case "sphere":
      return finish(orientFaces(lathe(sphereRings(shape.radius), 24)), true);
    case "capsule": {
      const r = shape.radius;
      const half = shape.height / 2 - r; // centers of the two hemispheres
      const rings = [...hemisphereRings(r, -half, false, 6), ...hemisphereRings(r, half, true, 6)];
      rings[0] = [0, -half - r];
      rings[rings.length - 1] = [0, half + r];
      return finish(orientFaces(lathe(rings, 24)), true);
    }
    default:
      throw new Error(`unknown shape type ${JSON.stringify(shape.type)}`);
  }
}

function sphereRings(r) {
  const rings = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    rings.push([i === 0 || i === steps ? 0 : Math.cos(a) * r, Math.sin(a) * r]);
  }
  return rings;
}

function finish(mesh, smooth) {
  return { positions: mesh.positions.map((p) => p.map(r6)), faces: mesh.faces, smooth };
}

/** Half extents of the shape's oriented bounding box (used by analysis). */
export function shapeHalfExtents(shape) {
  switch (shape.type) {
    case "box": return shape.size.map((v) => v / 2);
    case "cylinder": return [shape.radius, shape.radius, shape.height / 2];
    case "sphere": return [shape.radius, shape.radius, shape.radius];
    case "capsule": return [shape.radius, shape.radius, shape.height / 2];
    default: throw new Error(`unknown shape type ${JSON.stringify(shape.type)}`);
  }
}

/** Lowest world Z of a shape placed at pose {pos, quat}. */
export function lowestZ(shape, pose) {
  const [axisX, axisY, axisZ] = [qrotate(pose.quat, [1, 0, 0]), qrotate(pose.quat, [0, 1, 0]), qrotate(pose.quat, [0, 0, 1])];
  if (shape.type === "sphere") return pose.pos[2] - shape.radius;
  if (shape.type === "capsule") {
    const half = shape.height / 2 - shape.radius;
    return pose.pos[2] - Math.abs(axisZ[2]) * half - shape.radius;
  }
  if (shape.type === "cylinder") {
    const h = shape.height / 2;
    const horizontal = shape.radius * Math.hypot(axisX[2], axisY[2]);
    return pose.pos[2] - Math.abs(axisZ[2]) * h - horizontal;
  }
  const [hx, hy, hz] = shapeHalfExtents(shape);
  return pose.pos[2] - (Math.abs(axisX[2]) * hx + Math.abs(axisY[2]) * hy + Math.abs(axisZ[2]) * hz);
}

// ───────────────────────── humanoid rig ─────────────────────────

const capsuleBetween = (r, length) => ({ type: "capsule", radius: r, height: length + 2 * r });

/**
 * Fixed minimal humanoid. Proportions scale with height H. Joints rotate about their
 * own origin; offsets are in the parent joint's frame. Limbs hang down -Z at rest.
 * Positive X rotation swings a hanging limb forward (+Y).
 */
export function humanoidRig(H) {
  const u = H;
  const joints = [
    { name: "spine", parent: null, offset: [0, 0, 0.53 * u] },
    { name: "neck", parent: "spine", offset: [0, 0, 0.3 * u] },
    { name: "shoulderL", parent: "spine", offset: [-0.12 * u, 0, 0.27 * u] },
    { name: "shoulderR", parent: "spine", offset: [0.12 * u, 0, 0.27 * u] },
    { name: "elbowL", parent: "shoulderL", offset: [0, 0, -0.19 * u] },
    { name: "elbowR", parent: "shoulderR", offset: [0, 0, -0.19 * u] },
    { name: "hipL", parent: null, offset: [-0.055 * u, 0, 0.52 * u] },
    { name: "hipR", parent: null, offset: [0.055 * u, 0, 0.52 * u] },
    { name: "kneeL", parent: "hipL", offset: [0, 0, -0.25 * u] },
    { name: "kneeR", parent: "hipR", offset: [0, 0, -0.25 * u] },
  ];
  // Frames that are not joints: fixed offsets from a joint, same orientation.
  const points = [
    { name: "handL", parent: "elbowL", offset: [0, 0, -0.17 * u] },
    { name: "handR", parent: "elbowR", offset: [0, 0, -0.17 * u] },
    { name: "head", parent: "neck", offset: [0, 0, 0.1 * u] },
  ];
  const parts = [
    { name: "torso", joint: "spine", shape: capsuleBetween(0.085 * u, 0.27 * u), offset: [0, 0, 0.135 * u] },
    { name: "head", joint: "neck", shape: { type: "sphere", radius: 0.07 * u }, offset: [0, 0, 0.1 * u] },
    { name: "nose", joint: "neck", shape: { type: "box", size: [0.03 * u, 0.04 * u, 0.03 * u] }, offset: [0, 0.075 * u, 0.1 * u] },
  ];
  for (const side of ["L", "R"]) {
    parts.push(
      { name: `upperArm${side}`, joint: `shoulder${side}`, shape: capsuleBetween(0.035 * u, 0.19 * u), offset: [0, 0, -0.095 * u] },
      { name: `forearm${side}`, joint: `elbow${side}`, shape: capsuleBetween(0.03 * u, 0.17 * u), offset: [0, 0, -0.085 * u] },
      { name: `thigh${side}`, joint: `hip${side}`, shape: capsuleBetween(0.05 * u, 0.25 * u), offset: [0, 0, -0.125 * u] },
      // knee -> ankle is 0.23u, the ankle sits 0.04u above the floor = the shin's radius, so the foot touches z=0
      { name: `shin${side}`, joint: `knee${side}`, shape: capsuleBetween(0.04 * u, 0.23 * u), offset: [0, 0, -0.115 * u] },
    );
  }
  return { joints, points, parts };
}

function capsulePersonParts(H, radius) {
  return [
    { name: "body", joint: null, shape: { type: "capsule", radius, height: H }, offset: [0, 0, H / 2] },
    { name: "nose", joint: null, shape: { type: "box", size: [0.12 * radius, 0.2 * radius, 0.12 * radius] }, offset: [0, radius, 0.88 * H] },
  ];
}

// ───────────────────────── compile ─────────────────────────

const DEFAULTS = {
  background: "#202020",
  floor: "#4a4a4a",
  wall: "#8a8a8a",
  block: "#7a7a7a",
  subject: "#dcdcdc",
  prop: "#e0a040",
  shadow: "#151515",
  sensorWidth: 36,
};

function shapePose(pos, rotZ) {
  return { pos, quat: canon(qaxis(2, rotZ ?? 0)) };
}

/**
 * Raw (already validated) scene -> compiled form used by evaluate(). Resolves every
 * default and flattens keyframes into per-channel tables. Throws on shapes that cannot
 * be compiled; the Bun tool's validator reports friendlier errors before this.
 */
export function compileScene(scene) {
  const env = scene.environment ?? {};
  const nodes = [];

  const floor = env.floor ?? { size: [10, 10] };
  const fc = floor.center ?? [0, 0];
  nodes.push({
    id: "floor", group: "environment", ref: "floor",
    shape: { type: "box", size: [floor.size[0], floor.size[1], 0.1] },
    color: floor.color ?? DEFAULTS.floor,
    static: { pos: [fc[0], fc[1], -0.05], quat: IDENTITY_Q },
  });
  for (const w of env.walls ?? []) {
    const dx = w.to[0] - w.from[0];
    const dy = w.to[1] - w.from[1];
    const length = Math.hypot(dx, dy);
    const yaw = (Math.atan2(dy, dx) / DEG);
    nodes.push({
      id: `wall:${w.id}`, group: "environment", ref: w.id,
      shape: { type: "box", size: [length, w.thickness, w.height] },
      color: w.color ?? DEFAULTS.wall,
      static: { pos: [(w.from[0] + w.to[0]) / 2, (w.from[1] + w.to[1]) / 2, w.height / 2], quat: canon(qaxis(2, yaw)) },
    });
  }
  for (const b of env.blocks ?? []) {
    nodes.push({
      id: `block:${b.id}`, group: "environment", ref: b.id,
      shape: b.shape, color: b.color ?? DEFAULTS.block,
      static: shapePose(b.pos, b.rotZ),
    });
  }

  const subjects = [];
  for (const s of scene.subjects ?? []) {
    const kf = s.keyframes;
    const rig = s.kind === "humanoid" ? humanoidRig(s.height) : null;
    const parts = rig ? rig.parts : capsulePersonParts(s.height, s.radius ?? 0.12 * s.height);
    const shadowRadius = rig ? 0.18 * s.height : (s.radius ?? 0.12 * s.height) + 0.1;
    const sub = {
      id: s.id, kind: s.kind, height: s.height, rig, parts,
      shadow: s.shadow !== false,
      pos: collect(kf, (k) => k.pos),
      rot: collect(kf, (k) => k.rot),
      joints: {},
    };
    for (const j of rig ? rig.joints : []) sub.joints[j.name] = collect(kf, (k) => k.joints?.[j.name]);
    subjects.push(sub);
    for (const p of parts) {
      nodes.push({
        id: `subject:${s.id}/${p.name}`, group: "subject", ref: s.id, shape: p.shape,
        color: s.color ?? DEFAULTS.subject, dynamic: true,
      });
    }
    if (sub.shadow) {
      nodes.push({
        id: `shadow:${s.id}`, group: "shadow", ref: s.id,
        shape: { type: "cylinder", radius: shadowRadius, height: 0.004 },
        color: DEFAULTS.shadow, dynamic: true,
      });
    }
  }

  const props = [];
  for (const p of scene.props ?? []) {
    const kf = p.keyframes ?? [];
    props.push({
      id: p.id, shape: p.shape,
      pos: collect(kf, (k) => k.pos),
      rot: collect(kf, (k) => k.rot),
      attach: (p.attach ?? []).map((a) => ({ subject: a.subject, joint: a.joint, from: a.from, to: a.to, offset: a.offset ?? [0, 0, 0], rot: a.rot ?? [0, 0, 0] })),
    });
    nodes.push({ id: `prop:${p.id}`, group: "prop", ref: p.id, shape: p.shape, color: p.color ?? DEFAULTS.prop, dynamic: true });
  }

  const cam = scene.camera;
  const camera = {
    sensorWidth: cam.sensorWidth ?? DEFAULTS.sensorWidth,
    pos: collect(cam.keyframes, (k) => k.pos),
    target: collect(cam.keyframes, (k) => k.target),
    focalLength: collect(cam.keyframes, (k) => k.focalLength),
    roll: collect(cam.keyframes, (k) => k.roll),
  };

  const ov = scene.overview;
  return {
    id: scene.id,
    fps: scene.timing.fps,
    durationFrames: scene.timing.durationFrames,
    width: scene.frame.width,
    height: scene.frame.height,
    background: env.background ?? DEFAULTS.background,
    nodes, subjects, props, camera,
    overview: ov ? { frame: ov.frame ?? 0, pos: ov.pos ?? null, target: ov.target ?? null, focalLength: ov.focalLength ?? null } : { frame: 0, pos: null, target: null, focalLength: null },
  };
}

// ───────────────────────── evaluate ─────────────────────────

function sampleVec(keys, f, fallback) {
  return keys ? sampleKeys(keys, f) : fallback;
}

/** World frames of a subject: { root, joints:{name}, points:{name} }. */
function subjectFrames(sub, f) {
  const root = { pos: sampleVec(sub.pos, f, [0, 0, 0]), quat: eulerToQuat(sampleVec(sub.rot, f, [0, 0, 0])) };
  const joints = {};
  const points = {};
  if (!sub.rig) return { root, joints, points };
  const place = (def, rotation) => {
    const parent = def.parent ? joints[def.parent] ?? points[def.parent] : root;
    return compose(parent, def.offset, rotation);
  };
  for (const j of sub.rig.joints) joints[j.name] = place(j, eulerToQuat(sampleVec(sub.joints[j.name], f, [0, 0, 0])));
  for (const p of sub.rig.points) points[p.name] = place(p, IDENTITY_Q);
  return { root, joints, points };
}

function cameraPose(c, f) {
  const pos = sampleKeys(c.camera.pos, f);
  const target = sampleKeys(c.camera.target, f);
  const focal = sampleKeys(c.camera.focalLength, f)[0];
  const roll = c.camera.roll ? sampleKeys(c.camera.roll, f)[0] : 0;
  if (len(sub(target, pos)) < 1e-9) throw new Error(`camera target equals camera position at frame ${f}`);
  const forward = norm(sub(target, pos));
  const right = cross(forward, UP);
  if (len(right) < 1e-9) throw new Error(`camera looks straight along the up axis at frame ${f}; nudge pos or target`);
  const r = norm(right);
  const up = cross(r, forward);
  // camera frame: X = right, Y = up, Z = -forward; roll turns the image about the view axis
  const quat = qmul(basisToQuat(r, up, scale(forward, -1)), qaxis(2, -roll));
  const aspect = c.width / c.height;
  const fovY = (2 * Math.atan(c.camera.sensorWidth / aspect / 2 / focal)) / DEG;
  return { pos, quat: canon(quat), target, focalLength: focal, roll, fovY: r6(fovY), sensorWidth: c.camera.sensorWidth };
}

const cleanVec = (v) => v.map((x) => (Object.is(x, -0) ? 0 : x));
const outPose = (p) => ({ pos: cleanVec(p.pos), quat: canon(p.quat) });

/**
 * Everything at absolute time t (seconds). Returns:
 *   { time, frame, camera, nodes: {id: {pos, quat}}, frames: {subject:{root,joints,points}} }
 * `nodes` only has the animated nodes; static ones carry `static` in compiled.nodes.
 */
export function evaluate(c, t) {
  const f = frameAtTime(c, t);
  const nodes = {};
  const frames = {};
  for (const sub of c.subjects) {
    const fr = subjectFrames(sub, f);
    frames[sub.id] = fr;
    for (const part of sub.parts) {
      const base = part.joint ? fr.joints[part.joint] : fr.root;
      nodes[`subject:${sub.id}/${part.name}`] = outPose(compose(base, part.offset, IDENTITY_Q));
    }
    if (sub.shadow) {
      nodes[`shadow:${sub.id}`] = outPose({ pos: [fr.root.pos[0], fr.root.pos[1], 0.002], quat: IDENTITY_Q });
    }
  }
  for (const p of c.props) {
    let pose = { pos: sampleVec(p.pos, f, [0, 0, 0]), quat: eulerToQuat(sampleVec(p.rot, f, [0, 0, 0])) };
    const window = p.attach.find((a) => f >= a.from && f <= a.to);
    if (window) {
      const host = frames[window.subject];
      const frame = host.joints[window.joint] ?? host.points[window.joint];
      pose = compose(frame, window.offset, eulerToQuat(window.rot));
    }
    nodes[`prop:${p.id}`] = outPose(pose);
  }
  return { time: t, frame: f, camera: cameraPose(c, f), nodes, frames };
}

/** The prop's own keyframed pose, ignoring attachments (analysis compares it with the attached one). */
export function freePropPose(c, propId, f) {
  const p = c.props.find((x) => x.id === propId);
  return { pos: sampleVec(p.pos, f, [0, 0, 0]), quat: eulerToQuat(sampleVec(p.rot, f, [0, 0, 0])) };
}

/** Camera for the overview render: declared, or a framing of the whole scene. */
export function overviewCamera(c) {
  const ov = c.overview;
  const aspect = c.width / c.height;
  const focal = ov.focalLength ?? 24;
  const fovY = (2 * Math.atan(c.camera.sensorWidth / aspect / 2 / focal)) / DEG;
  let pos = ov.pos;
  let target = ov.target;
  if (!pos || !target) {
    // Everything the overview should show: set pieces, where subjects and props go, where the camera is.
    const pts = [];
    for (const n of c.nodes) {
      if (!n.static) continue;
      const h = shapeHalfExtents(n.shape);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [0, 1]) {
        pts.push(add(n.static.pos, qrotate(n.static.quat, [sx * h[0], sy * h[1], sz * h[2] * (n.static.pos[2] >= 0 ? 1 : 0)])));
      }
    }
    const keyed = (keys) => (keys ?? []).forEach((k) => pts.push(k.value));
    keyed(c.camera.pos);
    for (const sub of c.subjects) { keyed(sub.pos); pts.push(...(sub.pos ?? []).map((k) => add(k.value, [0, 0, sub.height]))); }
    for (const p of c.props) keyed(p.pos);
    const lo = [Infinity, Infinity, 0];
    const hi = [-Infinity, -Infinity, 0];
    for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    target = target ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0.4 * hi[2]];
    // seen from the front (-Y), swung to the left (-X), 35 degrees above the floor
    const elev = 35 * DEG;
    const az = 35 * DEG;
    const toCam = [-Math.cos(elev) * Math.sin(az), -Math.cos(elev) * Math.cos(az), Math.sin(elev)];
    const forward = scale(toCam, -1);
    const right = norm(cross(forward, UP));
    const up = cross(right, forward);
    const tanH = Math.tan((fovY * DEG) / 2);
    const tanW = tanH * aspect;
    // closest distance at which every point lies inside 90% of the frame
    let dist = 1;
    for (const p of pts) {
      const rel = sub(p, target);
      dist = Math.max(dist, Math.abs(dot(rel, right)) / (0.9 * tanW) - dot(rel, forward), Math.abs(dot(rel, up)) / (0.9 * tanH) - dot(rel, forward));
    }
    pos = pos ?? add(target, scale(toCam, dist));
  }
  const forward = norm(sub(target, pos));
  const r = norm(cross(forward, UP));
  const up = cross(r, forward);
  return { pos, quat: canon(basisToQuat(r, up, scale(forward, -1))), target, focalLength: focal, roll: 0, fovY: r6(fovY), sensorWidth: c.camera.sensorWidth };
}

// ───────────────────────── overview helpers ─────────────────────────

/** A flat ribbon following a polyline in XY at its own height: ground paths and camera path. */
function ribbon(points, width) {
  const positions = [];
  const faces = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const nx = -dy * width / 2;
    const ny = dx * width / 2;
    positions.push([points[i][0] + nx, points[i][1] + ny, points[i][2]], [points[i][0] - nx, points[i][1] - ny, points[i][2]]);
  }
  for (let i = 0; i + 1 < n; i++) faces.push([2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2]);
  return { positions: positions.map((p) => p.map(r6)), faces, smooth: false };
}

/** Pyramid with its apex at the camera and its base along the view axis. World-space mesh. */
function frustumMarker(cam, aspect, dist) {
  const f = norm(sub(cam.target, cam.pos));
  const r = norm(cross(f, UP));
  const u = cross(r, f);
  const halfH = Math.tan((cam.fovY * DEG) / 2) * dist;
  const halfW = halfH * aspect;
  const center = add(cam.pos, scale(f, dist));
  const corner = (sx, sy) => add(add(center, scale(r, sx * halfW)), scale(u, sy * halfH));
  const positions = [cam.pos, corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const faces = [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [1, 2, 3, 4]];
  return { positions: positions.map((p) => p.map(r6)), faces, smooth: false };
}

/**
 * Extra nodes that only the overview render shows: where every subject/prop goes and
 * where the camera is. Static world-space meshes, so engines need no extra code.
 */
export function overviewHelpers(c) {
  const out = [];
  const step = 1;
  const frames = [];
  for (let f = 0; f < c.durationFrames; f += step) frames.push(f);
  if (frames[frames.length - 1] !== c.durationFrames - 1) frames.push(c.durationFrames - 1);
  const samples = frames.map((f) => evaluate(c, timeAtFrame(c, f)));
  const palette = ["#3fa7ff", "#ff7a59", "#59d98e", "#d98ee0", "#ffd24a"];
  c.subjects.forEach((sub, i) => {
    const pts = samples.map((s) => [s.frames[sub.id].root.pos[0], s.frames[sub.id].root.pos[1], 0.006]);
    out.push({ id: `path:${sub.id}`, group: "helper", shape: { type: "mesh", mesh: ribbon(dedupe(pts), 0.09) }, color: palette[i % palette.length], static: { pos: [0, 0, 0], quat: IDENTITY_Q } });
  });
  const camPts = samples.map((s) => s.camera.pos);
  out.push({ id: "path:camera", group: "helper", shape: { type: "mesh", mesh: ribbon(dedupe(camPts), 0.07) }, color: "#ffe14a", static: { pos: [0, 0, 0], quat: IDENTITY_Q } });
  const aspect = c.width / c.height;
  for (const [name, s] of [["start", samples[0]], ["end", samples[samples.length - 1]]]) {
    out.push({ id: `camera:${name}`, group: "helper", shape: { type: "mesh", mesh: frustumMarker(s.camera, aspect, 0.8) }, color: name === "start" ? "#ffe14a" : "#ff9f1c", static: { pos: [0, 0, 0], quat: IDENTITY_Q } });
  }
  return out;
}

function dedupe(points) {
  const out = [points[0]];
  for (const p of points.slice(1)) if (len(sub(p, out[out.length - 1])) > 1e-6) out.push(p);
  return out.length > 1 ? out : [points[0], [points[0][0] + 1e-3, points[0][1], points[0][2]]];
}

/** The mesh for a node's shape (helpers carry a prebuilt mesh). */
export function meshForShape(shape) {
  return shape.type === "mesh" ? shape.mesh : buildMesh(shape);
}

export { add as vadd, sub as vsub, scale as vscale, dot as vdot, cross as vcross, len as vlen, norm as vnorm };
