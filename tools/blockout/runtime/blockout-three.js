// blockout-three — applies a blockout scene to a Three.js scene. It owns no motion
// logic: every pose comes from blockout-core's evaluate(), which is a pure function
// of absolute time. This file only maps (position, quaternion) onto meshes, once per
// `hf-seek`, so seeking to any time in any order gives the same pixels.
//
// Shipped verbatim inside the generated HyperFrames project, next to a vendored,
// pinned three.module.min.js: nothing is fetched at seek time.

import * as THREE from "./vendor/three.module.min.js";
import { compileScene, evaluate, meshForShape, overviewCamera, overviewHelpers, timeAtFrame } from "./blockout-core.js";

const geometryCache = new Map();

function geometryFor(shape) {
  const key = JSON.stringify(shape);
  let g = geometryCache.get(key);
  if (g) return g;
  const mesh = meshForShape(shape);
  const positions = new Float32Array(mesh.positions.length * 3);
  mesh.positions.forEach((p, i) => positions.set(p, i * 3));
  const index = [];
  for (const f of mesh.faces) for (let i = 1; i + 1 < f.length; i++) index.push(f[0], f[i], f[i + 1]);
  g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  // smooth surfaces share vertex normals; hard-edged ones get one normal per face
  if (!mesh.smooth) g = g.toNonIndexed();
  g.computeVertexNormals();
  geometryCache.set(key, g);
  return g;
}

/**
 * mode "video": the scene as the camera sees it, at the time passed to renderAt.
 * mode "overview": a fixed layout view at the declared overview frame, plus path helpers.
 */
export function mountBlockout({ canvas, data, mode = "video" }) {
  const c = compileScene(data);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(c.width, c.height, false);
  renderer.setClearColor(new THREE.Color(c.background), 1);

  const scene = new THREE.Scene();
  // blockout space is Z-up; Three.js is Y-up. One rotation here, nowhere else.
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-3, 8, 5);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, c.width / c.height, 0.05, 500);
  world.add(camera);

  const meshes = new Map();
  const add = (node) => {
    const m = new THREE.Mesh(geometryFor(node.shape), new THREE.MeshLambertMaterial({ color: new THREE.Color(node.color) }));
    if (node.static) {
      m.position.set(...node.static.pos);
      m.quaternion.set(...node.static.quat);
    }
    world.add(m);
    meshes.set(node.id, m);
  };
  c.nodes.forEach(add);
  if (mode === "overview") overviewHelpers(c).forEach(add);

  function applyCamera(cam) {
    camera.position.set(...cam.pos);
    camera.quaternion.set(...cam.quat);
    camera.fov = cam.fovY;
    camera.updateProjectionMatrix();
  }

  function renderAt(time) {
    const e = evaluate(c, mode === "overview" ? timeAtFrame(c, c.overview.frame) : time);
    for (const [id, pose] of Object.entries(e.nodes)) {
      const m = meshes.get(id);
      m.position.set(...pose.pos);
      m.quaternion.set(...pose.quat);
    }
    applyCamera(mode === "overview" ? overviewCamera(c) : e.camera);
    renderer.render(scene, camera);
    return e;
  }

  window.addEventListener("hf-seek", (event) => renderAt(event.detail.time));
  renderAt(window.__hfThreeTime || 0);
  // read-only handle for tests and debugging; the renders never consult it
  window.__blockout = { compiled: c, stateAt: (t) => evaluate(c, t) };
  return { renderAt, compiled: c };
}
