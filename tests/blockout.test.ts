// blockout end to end: the real CLI, real Blender, real HyperFrames/Three.js, real ffmpeg.
//
// Real renders are the point (frame count, fps, random seek, geometry), so a missing
// tool is never a silent pass: the gap is printed on stderr and the affected describe
// blocks are reported as skipped. `scripts/e2e-blockout.sh` is the same checks with
// every tool required (it installs the pinned HyperFrames itself).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { baseScene, blenderPath, cliJson, EXAMPLE, hyperframesPath, reportMissing, sandbox, tree, type Sandbox } from "../tools/blockout/test/fixtures.ts";
import { pixelHash, probeVideo } from "../tools/blockout/src/media.ts";
import type { Manifest } from "../tools/blockout/src/bundle.ts";
import { media, probe, project } from "./helpers.ts";

const BLENDER = blenderPath();
const HYPERFRAMES = hyperframesPath();
if (!BLENDER) reportMissing("Blender engine end-to-end", "Blender not found (set BLOCKOUT_TEST_BLENDER or BLOCKOUT_BLENDER); real Blender renders, the .blend replay and cross-engine comparison are NOT exercised");
if (!HYPERFRAMES) reportMissing("Three.js/HyperFrames engine end-to-end", "hyperframes CLI not found (set BLOCKOUT_HYPERFRAMES=<...>/node_modules/.bin/hyperframes; scripts/e2e-blockout.sh installs the pinned one); real Three.js renders are NOT exercised");
const blender = BLENDER ? describe : describe.skip;
const three = HYPERFRAMES ? describe : describe.skip;
const both = BLENDER && HYPERFRAMES ? describe : describe.skip;

const EXAMPLE_STILLS = [0, 8, 26, 55, 71];
const BUNDLE_TREE = ["keyframes", ...EXAMPLE_STILLS.map((f) => `keyframes/kf-${String(f).padStart(4, "0")}.png`), "manifest.json", "overview.png", "reference.mp4", "source.tar.gz"];

// ───────────────────────── helpers ─────────────────────────

const render = (engine: "blender" | "three", scene: string, out: string, ...extra: string[]) =>
  cliJson<{ manifest: string; artifacts: { role: string; path: string; sha256: string; size: number }[] }>(
    "render", scene, "--engine", engine, "--out", out,
    ...(engine === "blender" ? ["--blender", BLENDER ?? ""] : ["--hyperframes", HYPERFRAMES ?? ""]),
    ...extra,
  );

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
const sha = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

function ffmpegOut(args: string[]): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 1 << 28 });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() };
}

/** Frame n of a video, written as a PNG. */
function videoFrame(video: string, n: number, out: string): void {
  const r = ffmpegOut(["-y", "-i", video, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", out]);
  expect(r.status).toBe(0);
}

/** PSNR (dB) between two images of the same size. */
function psnr(a: string, b: string): number {
  const r = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" });
  const m = /average:(inf|[\d.]+)/.exec(r.stderr);
  expect(m).not.toBeNull();
  return m![1] === "inf" ? Infinity : Number(m![1]);
}

const raw = (p: string) => ffmpegOut(["-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;

/** 1 where the pixel differs from the background by more than a small threshold (any silhouette on screen). */
function silhouette(p: string, bg = 0x20): Uint8Array {
  const b = raw(p);
  const m = new Uint8Array(b.length / 3);
  for (let i = 0; i < m.length; i++) m[i] = Math.max(Math.abs(b[3 * i]! - bg), Math.abs(b[3 * i + 1]! - bg), Math.abs(b[3 * i + 2]! - bg)) > 12 ? 1 : 0;
  return m;
}

function bright(p: string, level: number): Uint8Array {
  const b = raw(p);
  const m = new Uint8Array(b.length / 3);
  for (let i = 0; i < m.length; i++) m[i] = (b[3 * i]! + b[3 * i + 1]! + b[3 * i + 2]!) / 3 > level ? 1 : 0;
  return m;
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either === 0 ? 1 : both / either;
}

function checkBundle(dir: string, engine: "blender" | "three", scenePath: string): Manifest {
  expect(tree(dir)).toEqual(BUNDLE_TREE);
  const m = readManifest(dir);
  expect(m.schema).toBe("blockout-manifest/v1alpha1");
  expect(m.purpose).toEqual({ use: ["motion", "blocking"], notFor: ["identity", "first-frame"] });
  expect(m.engine.name).toBe(engine);
  expect(m.scene.sha256).toBe(sha(scenePath));
  expect(m.render).toEqual({ width: 640, height: 360, fps: 24, durationFrames: 72, durationSeconds: 3 });
  // everything an upstream hand-off pins, explicit and readable: composition, shot AND scene, environment variant, subject/prop variants
  expect(m.binding).toEqual({
    composition: { id: "kitchen-story", revision: "12" },
    shot: { id: "s3-handoff", revision: "4" },
    scene: { id: "scene-kitchen", revision: "6" },
    environment: { id: "kitchen", revision: "2", variant: "day" },
    subjects: [
      { id: "ann", bindingId: "char-ann", revision: "7", variant: "apron", role: "character", kind: "humanoid" },
      { id: "ben", bindingId: "char-ben", revision: "3", variant: "default", role: "character", kind: "humanoid" },
    ],
    props: [{ id: "mug", bindingId: "prop-mug", revision: "1", variant: "default", role: "prop", kind: "cylinder" }],
  });
  expect(m.handoff).toEqual({ complete: true, missing: [] });
  // every artifact: real file, real size, real sha256, a mime, and a purpose (never identity / first frame)
  expect(m.artifacts.map((a) => a.role)).toEqual(["reference-video" as const, "overview" as const, ...EXAMPLE_STILLS.map(() => "keyframe" as const), "source-archive"] as Manifest["artifacts"][number]["role"][]);
  for (const a of m.artifacts) {
    expect(readFileSync(join(dir, a.path)).length).toBe(a.size);
    expect(sha(join(dir, a.path))).toBe(a.sha256);
    expect(a.assetId).toBe(`blockout-${a.sha256}`);
    expect(a.mime).toMatch(/^(video\/mp4|image\/png|application\/gzip)$/);
    if (a.role !== "source-archive") expect(a.use).toEqual(a.role === "reference-video" ? ["motion", "blocking"] : ["blocking"]);
  }
  expect(m.artifacts.filter((a) => a.role === "keyframe").map((a) => [a.frame, a.timeSeconds])).toEqual(EXAMPLE_STILLS.map((f) => [f, Math.round((f / 24) * 1e4) / 1e4]));
  return m;
}

/** A small valid scene (160x90) with an arbitrary fps and frame count. */
function shortScene(fps: number, frames: number) {
  const s = baseScene({ timing: { fps, durationFrames: frames } });
  s.subjects![0]!.keyframes[1]!.frame = frames - 1;
  return s;
}

// ───────────────────────── tool-free behavior ─────────────────────────

describe("blockout CLI without engines", () => {
  let box: Sandbox;
  beforeAll(() => {
    box = sandbox();
  });
  afterAll(() => box.cleanup());

  test("eval: state at an absolute time; ann's hand follows her arm; frames and seconds agree", async () => {
    const byFrame = await cliJson<{ frame: number; time: number; subjects: { ann: { points: { handR: number[] } } }; camera: { focalLength: number } }>("eval", EXAMPLE, "--frame", "24");
    const bySeconds = await cliJson<typeof byFrame.out>("eval", EXAMPLE, "--time", "1");
    expect(byFrame.exitCode).toBe(0);
    expect(byFrame.out!.frame).toBe(24);
    expect(bySeconds.out!.frame).toBe(24);
    expect(JSON.stringify(bySeconds.out!.subjects)).toBe(JSON.stringify(byFrame.out!.subjects));
    expect(byFrame.out!.camera.focalLength).toBeCloseTo(35, 6); // the declared key at frame 24
  });

  test("eval: shuffled and repeated calls give identical output (random seek is a pure function)", async () => {
    const frames = [60, 3, 71, 24, 3, 0, 60, 33];
    const first: Record<number, string> = {};
    for (const f of frames) {
      const r = await cliJson("eval", EXAMPLE, "--frame", String(f));
      const text = JSON.stringify(r.out);
      if (first[f] === undefined) first[f] = text;
      else expect(text).toBe(first[f]!);
    }
  });

  test("eval needs exactly one of --time/--frame", async () => {
    expect((await cliJson("eval", EXAMPLE)).exitCode).toBe(2);
    expect((await cliJson("eval", EXAMPLE, "--time", "1", "--frame", "2")).exitCode).toBe(2);
  });

  test("check: geometry/contact facts; --strict turns warnings into exit 2", async () => {
    const ok = await cliJson<{ occlusions: unknown[]; warnings: string[] }>("check", EXAMPLE, "--strict");
    expect(ok.exitCode).toBe(0);
    expect(ok.out!.occlusions.length).toBe(1);
    const s = baseScene();
    s.environment!.blocks![0]!.pos = [0, 1, 1]; // a wall on ann's path
    const bad = box.scene("walk-through-wall.json", s);
    expect((await cliJson("check", bad)).exitCode).toBe(0); // reported
    const strict = await cliJson("check", bad, "--strict");
    expect(strict.exitCode).toBe(2);
    expect(strict.err!.errors[0]!.message).toContain("is inside");
  });

  test("project --engine three writes a HyperFrames project: no network anywhere, pinned vendored three, atomic, never overwrites", async () => {
    const out = box.path("three-project");
    const r = await cliJson<{ files: string[] }>("project", EXAMPLE, "--engine", "three", "--out", out);
    expect(r.exitCode).toBe(0);
    expect(tree(out)).toEqual([
      "blockout-core.js", "blockout-three.js", "compositions", "compositions/overview.html", "index.html", "package.json", "scene-data.js", "vendor",
      "vendor/LICENSE-three", "vendor/three.core.min.js", "vendor/three.module.min.js",
    ]);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('data-duration="3"');
    expect(html).toContain('data-fps="24"');
    expect(html).toContain('data-width="640"');
    for (const f of ["index.html", "compositions/overview.html", "blockout-three.js", "blockout-core.js"]) {
      // nothing in the project reaches for the network
      expect(readFileSync(join(out, f), "utf8")).not.toMatch(/https?:\/\//);
    }
    // the vendored library is the pinned one
    expect(sha(join(out, "vendor/three.module.min.js"))).toBe("979c1ae4b0579c9901eacf797602c0b46df129d87102c6443d14be4a1f790b70");
    // the shared evaluator ships byte for byte
    expect(sha(join(out, "blockout-core.js"))).toBe(sha(join(import.meta.dir, "../tools/blockout/runtime/blockout-core.js")));
    // a second project into the same place is refused and changes nothing
    const before = tree(out);
    const again = await cliJson("project", EXAMPLE, "--engine", "three", "--out", out);
    expect(again.exitCode).toBe(1);
    expect(tree(out)).toEqual(before);
    expect((await cliJson("project", EXAMPLE, "--engine", "three", "--out", out, "--force")).exitCode).toBe(0);
  });

  test("project output is deterministic: the same declaration gives byte-identical projects", async () => {
    await cliJson("project", EXAMPLE, "--engine", "three", "--out", box.path("p-a"));
    await cliJson("project", EXAMPLE, "--engine", "three", "--out", box.path("p-b"));
    for (const f of tree(box.path("p-a")).filter((f) => f.includes("."))) expect(sha(box.path(`p-a/${f}`))).toBe(sha(box.path(`p-b/${f}`)));
  });

  test("render refuses to overwrite: exit 1 before any work, existing files untouched", async () => {
    const dest = box.path("occupied");
    mkdirSync(dest);
    writeFileSync(join(dest, "reference.mp4"), "my precious video");
    const before = tree(dest);
    const r = await cliJson("render", EXAMPLE, "--engine", "blender", "--out", dest);
    expect(r.exitCode).toBe(1);
    expect(r.err!.errors[0]!.message).toContain("refusing to overwrite");
    expect(tree(dest)).toEqual(before);
    expect(readFileSync(join(dest, "reference.mp4"), "utf8")).toBe("my precious video");
  });

  test("an invalid declaration: exit 2, and the destination is never created", async () => {
    const bad = box.scene("bad.json", { ...baseScene(), surprise: true });
    const dest = box.path("never-created");
    const r = await cliJson("render", bad, "--engine", "blender", "--out", dest);
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.field).toBe("surprise");
    expect(existsSync(dest)).toBe(false);
  });

  test("a named Blender that does not exist is missing-dependency (exit 3) with the search in the hint; nothing is left behind", async () => {
    const dest = box.path("nested/deeper/no-blender"); // directories the call had to create are removed again
    const r = await cliJson("render", EXAMPLE, "--engine", "blender", "--out", dest, "--blender", "/no/such/Blender");
    expect(r.exitCode).toBe(3);
    expect(r.err!.errors[0]!.code).toBe("missing-dependency");
    expect(r.err!.errors[0]!.hint).toContain("/no/such/Blender");
    expect(existsSync(box.path("nested"))).toBe(false);
  });

  test("a HyperFrames that does not exist is missing-dependency (exit 3) with install guidance", async () => {
    const dest = box.path("no-hf");
    const r = await cliJson("render", EXAMPLE, "--engine", "three", "--out", dest, "--hyperframes", "/no/such/hyperframes");
    expect(r.exitCode).toBe(3);
    expect(r.err!.errors[0]!.hint).toContain("npm install");
    expect(existsSync(dest)).toBe(false);
  });

  test("--video and --manifest must share a directory (the other artifacts land beside them)", async () => {
    const r = await cliJson("render", EXAMPLE, "--engine", "blender", "--video", box.path("a/reference.mp4"), "--manifest", box.path("b/manifest.json"));
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.field).toBe("--manifest");
  });

  test("a Blender that starts but crashes: tool-failure (exit 4), staging removed, destination as before", async () => {
    const fake = box.path("fake-blender");
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Blender 5.2.3 LTS"; echo "\tbuild hash: abc123"; exit 0; fi\necho "Error: simulated Blender crash" >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    const dest = box.path("crashed");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "mine");
    const before = tree(dest);
    const r = await cliJson("render", EXAMPLE, "--engine", "blender", "--out", dest, "--blender", fake);
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.code).toBe("tool-failure");
    expect(r.err!.errors[0]!.hint).toContain("simulated Blender crash");
    expect(tree(dest)).toEqual(before);
  });

  test("doctor reports every tool with a name, a detail and a hint when missing", async () => {
    const r = await cliJson<{ ready: boolean; checks: { name: string; ok: boolean; detail: string }[] }>("doctor", "--engine", "blender", "--blender", "/no/such/Blender");
    expect(r.exitCode).toBe(3);
    expect(r.out!.ready).toBe(false);
    expect(r.out!.checks.find((c) => c.name === "blender")!.ok).toBe(false);
    expect(r.out!.checks.find((c) => c.name === "ffmpeg")!.ok).toBe(true);
    expect(r.out!.checks.find((c) => c.name.startsWith("three.js"))!.detail).toContain("sha256 verified");
  });
});

// ───────────────────────── Blender, for real ─────────────────────────

blender("blender engine: real Blender render of the counter-handoff scene", () => {
  let box: Sandbox;
  let dir: string;
  let manifest: Manifest;
  beforeAll(async () => {
    box = sandbox();
    dir = box.path("bundle");
    const r = await render("blender", EXAMPLE, dir);
    expect(r.exitCode).toBe(0);
    manifest = checkBundle(dir, "blender", EXAMPLE);
  }, 180_000);
  afterAll(() => box?.cleanup());

  test("the video has exactly the declared frame count, fps, size, codec and color tags (measured independently)", async () => {
    const v = await probeVideo(join(dir, "reference.mp4"));
    expect(v.frames).toBe(72);
    expect(v.fps).toBe(24);
    expect([v.width, v.height]).toEqual([640, 360]);
    expect(v.codec).toBe("h264");
    expect(v.pixelFormat).toBe("yuv420p");
    expect(v.durationSeconds).toBeCloseTo(3, 3);
    const tags = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=color_space,color_range,r_frame_rate,nb_frames", "-of", "default=nw=1", join(dir, "reference.mp4")], { encoding: "utf8" }).stdout;
    expect(tags).toContain("color_space=bt709");
    expect(tags).toContain("r_frame_rate=24/1");
    expect(tags).toContain("nb_frames=72");
    expect(manifest.artifacts[0]).toMatchObject({ frames: 72, fps: 24, width: 640, height: 360 });
  });

  test("keyframe stills are the video's own frames: frame number and time line up", () => {
    for (const f of EXAMPLE_STILLS) {
      const out = box.path(`vf-${f}.png`);
      videoFrame(join(dir, "reference.mp4"), f, out);
      expect(psnr(out, join(dir, `keyframes/kf-${String(f).padStart(4, "0")}.png`))).toBeGreaterThan(30);
    }
    // and they are not interchangeable: frame 0 is not frame 55
    const wrong = box.path("wrong.png");
    videoFrame(join(dir, "reference.mp4"), 0, wrong);
    expect(psnr(wrong, join(dir, "keyframes/kf-0055.png"))).toBeLessThan(25);
  });

  test("random seek: the tool rendered frames out of order and every pose and pixel matched", () => {
    const seek = manifest.verification.seek;
    expect(seek.status).toBe("verified");
    expect(seek.identical).toBe(true);
    expect(seek.frames.length).toBe(3);
    expect([...seek.frames]).not.toEqual([...seek.frames].sort((a, b) => a - b)); // visited out of order, on purpose
    expect(seek.stateMaxError!).toBeLessThan(1e-4);
    expect(manifest.verification.frames).toEqual({ expected: 72, images: 72, video: 72 });
  });

  test("the archived .blend renders a frame with plain `blender -b scene.blend -f N` to the same pixels as the delivered still", async () => {
    const x = box.path("extracted");
    mkdirSync(x);
    expect(spawnSync("tar", ["xzf", join(dir, "source.tar.gz"), "-C", x]).status).toBe(0);
    expect(readFileSync(join(x, "source/scene.json"))).toEqual(readFileSync(EXAMPLE)); // the declaration, verbatim
    expect(tree(x).filter((p) => p.startsWith("source/blender/")).map((p) => p.replace("source/blender/", ""))).toEqual(["README.txt", "bake.json", "build_scene.py", "render_overview.py", "scene.blend", "validate_scene.py", "verify_seek.py"]);
    const shot = box.path("replay/f_####");
    const r = spawnSync(BLENDER!, ["-b", join(x, "source/blender/scene.blend"), "-o", shot, "-f", "26"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(await pixelHash(box.path("replay/f_0026.png"))).toBe(await pixelHash(join(dir, "keyframes/kf-0026.png")));
  }, 60_000);

  test("the manifest's source archive lists every file with the hashes of the bytes inside", () => {
    const archive = manifest.artifacts.find((a) => a.role === "source-archive")!;
    const x = box.path("extracted2");
    mkdirSync(x);
    spawnSync("tar", ["xzf", join(dir, "source.tar.gz"), "-C", x]);
    for (const f of archive.files!) expect(sha(join(x, f.path))).toBe(f.sha256);
    expect(archive.files!.map((f) => f.path)).toContain("source/blender/scene.blend");
  });

  test("white-model geometry and contact facts are in the manifest", () => {
    const a = manifest.analysis;
    expect(a.occlusions).toEqual([{ subject: "ann", state: "occluded", by: ["partition"], from: 31, to: 44 }]);
    expect(a.attachments.map((x) => [x.prop, x.subject, x.joint, x.from, x.to])).toEqual([["mug", "ann", "handR", 8, 55], ["mug", "ben", "handR", 56, 71]]);
    expect(a.attachments.every((x) => !x.teleport)).toBe(true);
    expect(a.groundContact.find((g) => g.id === "ann")!.belowFloorFrames).toBe(0);
    expect(a.penetrations).toEqual([]);
    expect(manifest.engine.pins.blender).toMatch(/^5\.\d+\.\d+/);
  });

  test("no artifact carries a local path (PNG metadata stamps are off)", () => {
    for (const rel of ["overview.png", "keyframes/kf-0000.png", "keyframes/kf-0071.png"]) {
      const bytes = readFileSync(join(dir, rel)).toString("latin1");
      expect(bytes).not.toContain(tmpdir());
      expect(bytes).not.toContain(process.env.HOME ?? "/Users/");
      expect(bytes).not.toContain(".blend");
      expect(bytes).not.toContain("tEXt");
    }
  });

  test("rendering again gives byte-identical media (deterministic)", async () => {
    const again = box.path("again");
    expect((await render("blender", EXAMPLE, again)).exitCode).toBe(0);
    expect(sha(join(again, "reference.mp4"))).toBe(sha(join(dir, "reference.mp4")));
    for (const rel of ["overview.png", ...EXAMPLE_STILLS.map((f) => `keyframes/kf-${String(f).padStart(4, "0")}.png`)]) {
      expect(sha(join(again, rel))).toBe(sha(join(dir, rel)));
    }
  }, 120_000);

  test("validate --native: Blender opens the project generated from the declaration", async () => {
    const r = await cliJson<{ native: { engine: string; objects: number } }>("validate", EXAMPLE, "--engine", "blender", "--native", "--blender", BLENDER!);
    expect(r.exitCode).toBe(0);
    expect(r.out!.native.engine).toBe("blender");
    expect(r.out!.native.objects).toBeGreaterThan(30);
  }, 60_000);

  test("the destination is never overwritten; --force replaces the whole bundle and leaves unrelated files alone", async () => {
    const dest = box.path("force");
    mkdirSync(join(dest, "keyframes"), { recursive: true });
    writeFileSync(join(dest, "reference.mp4"), "old video");
    writeFileSync(join(dest, "keyframes/kf-9999.png"), "old still");
    writeFileSync(join(dest, "unrelated.txt"), "keep me");
    const refused = await render("blender", EXAMPLE, dest);
    expect(refused.exitCode).toBe(1);
    expect(readFileSync(join(dest, "reference.mp4"), "utf8")).toBe("old video");
    const forced = await render("blender", EXAMPLE, dest, "--force");
    expect(forced.exitCode).toBe(0);
    expect(sha(join(dest, "reference.mp4"))).toBe(sha(join(dir, "reference.mp4")));
    expect(existsSync(join(dest, "keyframes/kf-9999.png"))).toBe(false);
    expect(readFileSync(join(dest, "unrelated.txt"), "utf8")).toBe("keep me");
    expect(tree(dest)).toEqual([...BUNDLE_TREE, "unrelated.txt"].sort());
  }, 120_000);

  test("ffmpeg dying at the encode, after Blender rendered everything: tool-failure, nothing left, existing files untouched", async () => {
    const bin = mkdtempSync(join(tmpdir(), "blockout-fakeffmpeg-"));
    // answers `-version` so preflight passes, then crashes on the real encode
    writeFileSync(join(bin, "ffmpeg"), '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version 9.9-fake"; exit 0; fi\necho "simulated ffmpeg crash" >&2\nexit 187\n', { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const dest = box.path("ffmpeg-dies");
      mkdirSync(dest);
      writeFileSync(join(dest, "notes.txt"), "mine");
      const before = tree(dest);
      const r = await render("blender", EXAMPLE, dest, "--seek-samples", "0"); // the seek check also uses ffmpeg; skip it to reach the encode
      expect(r.exitCode).toBe(4);
      expect(r.err!.errors[0]!.message).toContain("ffmpeg encode failed");
      expect(r.err!.errors[0]!.hint).toContain("simulated ffmpeg crash");
      expect(tree(dest)).toEqual(before); // no staging directory, no half bundle
    } finally {
      process.env.PATH = prev;
      rmSync(bin, { recursive: true, force: true });
    }
  }, 120_000);

  test("project --engine blender writes the scripts, the bake and a scene.blend that opens and renders from the plain CLI", async () => {
    const out = box.path("blender-project");
    const r = await cliJson("project", EXAMPLE, "--engine", "blender", "--out", out, "--blender", BLENDER!);
    expect(r.exitCode).toBe(0);
    expect(tree(out)).toEqual(["README.txt", "bake.json", "build_scene.py", "render_overview.py", "scene.blend", "validate_scene.py", "verify_seek.py"]);
    const bake = JSON.parse(readFileSync(join(out, "bake.json"), "utf8")) as { protocol: string; durationFrames: number; camera: unknown[] };
    expect([bake.protocol, bake.durationFrames, bake.camera.length]).toEqual(["blockout-bake/v1alpha1", 72, 72]);
    expect((await cliJson("project", EXAMPLE, "--engine", "blender", "--out", out, "--blender", BLENDER!)).exitCode).toBe(1); // never overwrites
    const frame = spawnSync(BLENDER!, ["-b", join(out, "scene.blend"), "-o", box.path("pf/f_####"), "-f", "40"], { encoding: "utf8" });
    expect(frame.status).toBe(0);
    expect(existsSync(box.path("pf/f_0040.png"))).toBe(true);
  }, 60_000);

  test("interrupted mid-render (SIGTERM): exit 143, Blender is stopped, staging removed, the destination is as it was", async () => {
    const dest = box.path("interrupted");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "mine");
    const child = Bun.spawn(["bun", join(import.meta.dir, "../tools/blockout/bin/blockout.ts"), "render", EXAMPLE, "--engine", "blender", "--out", dest, "--blender", BLENDER!], { stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 30_000;
    while (!tree(dest).some((n) => n.startsWith(".blockout-staging-")) && Date.now() < deadline) await Bun.sleep(10);
    expect(tree(dest).some((n) => n.startsWith(".blockout-staging-"))).toBe(true); // it had started working
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(tree(dest)).toEqual(["keep.txt"]);
    await Bun.sleep(300);
    expect(spawnSync("pgrep", ["-f", box.dir]).status).not.toBe(0); // no Blender or ffmpeg still running for this render
  }, 60_000);

  test("another fps and frame count (30 fps, 17 frames, 160x90) come out exact", async () => {
    const scene = box.scene("odd.json", shortScene(30, 17));
    const out = box.path("odd");
    const r = await render("blender", scene, out, "--seek-samples", "0");
    expect(r.exitCode).toBe(0);
    const v = await probeVideo(join(out, "reference.mp4"));
    expect([v.frames, v.fps, v.width, v.height]).toEqual([17, 30, 160, 90]);
    // Skipping the random-seek check is not a passing check: the manifest says "skipped", never identical: true
    const seek = readManifest(out).verification.seek;
    expect(seek).toMatchObject({ status: "skipped", frames: [], identical: null });
    expect(seek.method).toContain("not verified");
    expect("stateMaxError" in seek).toBe(false);
    // a pure-geometry scene: the manifest says exactly which binding fields a hand-off would still need
    const m = readManifest(out);
    expect(m.binding).toMatchObject({ composition: { id: "c", revision: "1" }, shot: { id: "s", revision: "1" } });
    expect("scene" in m.binding).toBe(false);
    expect(m.handoff).toEqual({ complete: false, missing: ["binding.scene", "binding.environment.variant", "subjects[0].binding.variant"] });
  }, 120_000);
});

// ───────────────────────── Three.js / HyperFrames, for real ─────────────────────────

three("three engine: real HyperFrames + three.js render of the counter-handoff scene", () => {
  let box: Sandbox;
  let dir: string;
  let manifest: Manifest;
  beforeAll(async () => {
    box = sandbox();
    dir = box.path("bundle");
    const r = await render("three", EXAMPLE, dir);
    expect(r.exitCode).toBe(0);
    manifest = checkBundle(dir, "three", EXAMPLE);
  }, 240_000);
  afterAll(() => box?.cleanup());

  test("frame count, fps and size are exactly what the declaration says (measured independently)", async () => {
    const v = await probeVideo(join(dir, "reference.mp4"));
    expect([v.frames, v.fps, v.width, v.height, v.codec, v.pixelFormat]).toEqual([72, 24, 640, 360, "h264", "yuv420p"]);
    expect(v.durationSeconds).toBeCloseTo(3, 3);
  });

  test("keyframe stills are the video's own frames", () => {
    for (const f of EXAMPLE_STILLS) {
      const out = box.path(`vf-${f}.png`);
      videoFrame(join(dir, "reference.mp4"), f, out);
      expect(psnr(out, join(dir, `keyframes/kf-${String(f).padStart(4, "0")}.png`))).toBeGreaterThan(30);
    }
  });

  test("random seek: HyperFrames snapshots of exact instants, requested out of order, are pixel-identical to the sequential frames", () => {
    const seek = manifest.verification.seek;
    expect(seek.status).toBe("verified");
    expect(seek.identical).toBe(true);
    expect(seek.frames.length).toBe(3);
    expect([...seek.frames]).not.toEqual([...seek.frames].sort((a, b) => a - b));
  });

  test("engine pins record the vendored three.js hashes and the HyperFrames version", () => {
    expect(manifest.engine.version).toBe("0.181.2");
    expect(manifest.engine.pins["three.module.min.js"]).toBe("979c1ae4b0579c9901eacf797602c0b46df129d87102c6443d14be4a1f790b70");
    expect(manifest.engine.pins.hyperframes).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the source archive is a self-contained HyperFrames project: three.js is vendored and nothing is fetched", () => {
    const x = box.path("extracted");
    mkdirSync(x);
    expect(spawnSync("tar", ["xzf", join(dir, "source.tar.gz"), "-C", x]).status).toBe(0);
    const files = tree(x);
    expect(files).toContain("source/three/vendor/three.module.min.js");
    expect(files).toContain("source/three/index.html");
    expect(files).toContain("source/scene.json");
    expect(files.some((f) => f.includes("node_modules") || f.includes(".hyperframes"))).toBe(false);
  });

  test("rendering again gives pixel-identical stills (deterministic)", async () => {
    const again = box.path("again");
    expect((await render("three", EXAMPLE, again)).exitCode).toBe(0);
    for (const rel of ["overview.png", ...EXAMPLE_STILLS.map((f) => `keyframes/kf-${String(f).padStart(4, "0")}.png`)]) {
      expect(await pixelHash(join(again, rel))).toBe(await pixelHash(join(dir, rel)));
    }
  }, 180_000);

  test("validate --native: `hyperframes check` accepts the generated project", async () => {
    const r = await cliJson<{ native: { engine: string; hyperframes: string } }>("validate", EXAMPLE, "--engine", "three", "--native", "--hyperframes", HYPERFRAMES!);
    expect(r.exitCode).toBe(0);
    expect(r.out!.native.engine).toBe("three");
  }, 120_000);

  test("a different fps and frame count (25 fps, 21 frames) come out exact", async () => {
    const scene = box.scene("odd.json", shortScene(25, 21));
    const out = box.path("odd");
    expect((await render("three", scene, out, "--seek-samples", "2")).exitCode).toBe(0);
    const v = await probeVideo(join(out, "reference.mp4"));
    expect([v.frames, v.fps, v.width, v.height]).toEqual([21, 25, 160, 90]);
  }, 180_000);

  test("HyperFrames failing: tool-failure (exit 4), destination untouched", async () => {
    const fake = box.path("fake-hyperframes");
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.8.204"; exit 0; fi\necho "simulated render failure" >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    const dest = box.path("hf-dies");
    mkdirSync(dest);
    writeFileSync(join(dest, "notes.txt"), "mine");
    const before = tree(dest);
    const r = await cliJson("render", EXAMPLE, "--engine", "three", "--out", dest, "--hyperframes", fake);
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.hint).toContain("simulated render failure");
    expect(tree(dest)).toEqual(before);
  }, 60_000);
});

// ───────────────────────── both engines, same declaration ─────────────────────────

both("two engines, one declaration", () => {
  let box: Sandbox;
  let b: string;
  let t: string;
  beforeAll(async () => {
    box = sandbox();
    b = box.path("blender");
    t = box.path("three");
    expect((await render("blender", EXAMPLE, b)).exitCode).toBe(0);
    expect((await render("three", EXAMPLE, t)).exitCode).toBe(0);
  }, 300_000);
  afterAll(() => box?.cleanup());

  test("same frames, same fps, same size, same binding, same analysis", () => {
    const mb = readManifest(b);
    const mt = readManifest(t);
    expect(mb.render).toEqual(mt.render);
    expect(mb.binding).toEqual(mt.binding);
    expect(mb.scene).toEqual(mt.scene);
    expect(mb.analysis).toEqual(mt.analysis);
    expect(mb.artifacts.filter((a) => a.role === "keyframe").map((a) => a.path)).toEqual(mt.artifacts.filter((a) => a.role === "keyframe").map((a) => a.path));
  });

  test("they draw the same geometry from the same camera: silhouettes agree on every keyframe and the overview", () => {
    for (const rel of [...EXAMPLE_STILLS.map((f) => `keyframes/kf-${String(f).padStart(4, "0")}.png`), "overview.png"]) {
      const sb = silhouette(join(b, rel));
      const st = silhouette(join(t, rel));
      expect(iou(sb, st)).toBeGreaterThan(0.97);
    }
  });

  test("the white figures and the props land in the same pixels (camera path, joints and attach agree)", () => {
    for (const f of [0, 26, 55]) {
      const rel = `keyframes/kf-${String(f).padStart(4, "0")}.png`;
      expect(iou(bright(join(b, rel), 150), bright(join(t, rel), 150))).toBeGreaterThan(0.8);
    }
  });
});

// ───────────────────────── through filmkit ─────────────────────────

function withShim<T>(fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "blockout-shim-"));
  writeFileSync(join(bin, "blockout"), `#!/bin/sh\nexec bun ${join(import.meta.dir, "../tools/blockout/bin/blockout.ts")} "$@"\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
    rmSync(bin, { recursive: true, force: true });
  }
}

/**
 * The reference is a generated ASSET, referenced from the real scene's intent: it never enters the final
 * sequence by itself. (A deliberately authored white-model animatic is a separate Film: see below.)
 */
const BLENDER_FILM = `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: bo }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/blender.yaml
assets:
  motion-ref:
    kind: video
    impl:
      profile: blender
      task: render
      params: { scene: ./blockout/s3.json }
    produces:
      video: ./build/blockout/s3/reference.mp4
      file: ./build/blockout/s3/manifest.json
output:
  container: mp4
  video: { width: 320, height: 180, fps: 24, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: final
    duration: 2
    durationPolicy: exact
    intent: { description: the real shot, references: [motion-ref] }
    impl: { profile: filmkit/static, task: clip, params: {} }
    produces: { image: ./assets/final.png }
`;

const ANIMATIC_FILM = `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: animatic }
profiles:
  - ref: filmkit/static
output:
  container: mp4
  video: { width: 320, height: 180, fps: 24, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: animatic
    duration: 3
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip, params: {} }
    produces: { video: ./build/blockout/s3/reference.mp4 }
`;

blender("filmkit consumes the Blender engine through profiles/blender.yaml", () => {
  const setup = () => {
    const p = project();
    p.write("profiles/blender.yaml", readFileSync(join(import.meta.dir, "../profiles/blender.yaml"), "utf8"));
    p.write("blockout/s3.json", readFileSync(EXAMPLE, "utf8"));
    p.write("filmkit.yaml", BLENDER_FILM);
    media.png(p.path("assets/final.png"), 320, 180);
    return p;
  };

  test("validate (native delegate) -> plan -> run -> status -> build: the reference is an asset, the film is the real scene", () =>
    withShim(() => {
      const p = setup();
      const prevBlender = process.env.BLOCKOUT_BLENDER;
      process.env.BLOCKOUT_BLENDER = BLENDER!;
      try {
        expect(p.json("validate").exitCode).toBe(0);
        const plan = p.json<{ nodes: { id: string; status: string; executor: string }[] }>("plan");
        expect(plan.out!.nodes.map((n) => [n.id, n.status, n.executor])).toEqual([["motion-ref", "missing", "filmkit run"]]);
        const run = p.json<{ produces: Record<string, string> }>("run", "motion-ref");
        expect(run.exitCode).toBe(0);
        expect(tree(p.path("build/blockout/s3"))).toEqual(BUNDLE_TREE);
        const m = JSON.parse(readFileSync(p.path("build/blockout/s3/manifest.json"), "utf8")) as Manifest;
        expect(m.scene.sha256).toBe(sha(EXAMPLE));
        const status = p.json<{ nodes: { id: string; status: string }[] }>("status");
        expect(status.out!.nodes.find((n) => n.id === "motion-ref")!.status).toBe("ready");
        const lock = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
        expect(lock).toContain("reference.mp4");
        expect(lock).toContain("manifest.json");
        // the reference never enters the final film: the build is the 2 s real scene, not the 3 s reference
        expect(p.json("build", "--draft").exitCode).toBe(0);
        expect(probe(p.path("build/bo.draft.mp4")).duration).toBeCloseTo(2, 0);
        // a deliberately authored white-model animatic is a separate Film that uses the same file as its scene
        p.write("animatic.yaml", ANIMATIC_FILM);
        expect(p.json("build", "--film", "animatic.yaml", "--draft").exitCode).toBe(0);
        expect(probe(p.path("build/animatic.draft.mp4")).duration).toBeCloseTo(3, 0);
        // editing the declaration makes the reference stale (the scene path is content-hashed), the real scene is untouched
        p.write("blockout/s3.json", readFileSync(EXAMPLE, "utf8").replace('"revision": "4"', '"revision": "5"'));
        const after = p.json<{ nodes: { id: string; status: string }[] }>("status").out!.nodes;
        expect(after.find((n) => n.id === "motion-ref")!.status).toBe("stale");
        expect(after.find((n) => n.id === "final")!.status).toBe("ready");
      } finally {
        if (prevBlender === undefined) delete process.env.BLOCKOUT_BLENDER;
        else process.env.BLOCKOUT_BLENDER = prevBlender;
        p.cleanup();
      }
    }), 240_000);

  test("an invalid declaration is caught by `filmkit validate` (delegated, exit 2 with the tool's field), before any rendering", () =>
    withShim(() => {
      const p = setup();
      try {
        p.write("blockout/s3.json", readFileSync(EXAMPLE, "utf8").replace('"kind": "BlockoutScene"', '"kind": "BlockoutScene", "oops": 1'));
        const v = p.json("validate");
        expect(v.exitCode).toBe(2);
        expect(JSON.stringify(v.err)).toContain("unknown field");
        expect(existsSync(p.path("build"))).toBe(false);
      } finally {
        p.cleanup();
      }
    }));

  test("a render that fails leaves no bundle and no lock (filmkit's own recovery on top of the tool's)", () =>
    withShim(() => {
      const p = setup();
      const prev = process.env.BLOCKOUT_BLENDER;
      process.env.BLOCKOUT_BLENDER = "/no/such/Blender";
      try {
        const r = p.json("run", "motion-ref");
        expect(r.exitCode).toBe(3);
        expect(existsSync(p.path("build/blockout/s3/reference.mp4"))).toBe(false);
        expect(existsSync(p.path("build/blockout/s3/manifest.json"))).toBe(false);
        expect(existsSync(p.path("filmkit.lock.yaml"))).toBe(false);
        // filmkit validates (delegated) before it runs anything, so there is no bundle directory at all
        expect(existsSync(p.path("build/blockout/s3")) ? tree(p.path("build/blockout/s3")) : []).toEqual([]);
      } finally {
        if (prev === undefined) delete process.env.BLOCKOUT_BLENDER;
        else process.env.BLOCKOUT_BLENDER = prev;
        p.cleanup();
      }
    }));

  test("doctor runs the Profile's healthcheck (blockout doctor --engine blender)", () =>
    withShim(() => {
      const p = setup();
      const prev = process.env.BLOCKOUT_BLENDER;
      process.env.BLOCKOUT_BLENDER = BLENDER!;
      try {
        expect(p.cli("doctor").exitCode).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.BLOCKOUT_BLENDER;
        else process.env.BLOCKOUT_BLENDER = prev;
        p.cleanup();
      }
    }), 60_000);
});

// the Three.js engine needs no Profile of its own: its project goes through profiles/hyperframes.yaml
three("filmkit renders the generated Three.js project through the existing hyperframes profile", () => {
  test("blockout project --engine three -> filmkit run (hyperframes render) -> an mp4 with the declared frame count", async () => {
    const p = project();
    try {
      p.write("profiles/hyperframes.yaml", readFileSync(join(import.meta.dir, "../profiles/hyperframes.yaml"), "utf8"));
      const proj = p.path("video");
      expect((await cliJson("project", EXAMPLE, "--engine", "three", "--out", proj)).exitCode).toBe(0);
      // the profile runs `npx --no-install hyperframes` inside the project: make the already-installed CLI resolvable there
      const nodeModules = dirname(dirname(dirname(HYPERFRAMES!.startsWith("/") ? HYPERFRAMES! : Bun.which(HYPERFRAMES!)!)));
      symlinkSync(existsSync(join(nodeModules, "node_modules")) ? join(nodeModules, "node_modules") : nodeModules, join(proj, "node_modules"));
      p.write("filmkit.yaml", `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: bo3 }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/hyperframes.yaml
assets:
  motion-ref:
    kind: video
    impl:
      profile: hyperframes
      task: render
      params: { project: ./video, fps: 24 }
    produces: { video: ./build/ref.mp4 }
output:
  container: mp4
  video: { width: 320, height: 180, fps: 24, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: final
    duration: 2
    durationPolicy: exact
    intent: { references: [motion-ref] }
    impl: { profile: filmkit/static, task: clip, params: {} }
    produces: { image: ./assets/final.png }
`);
      media.png(p.path("assets/final.png"), 320, 180);
      expect(p.json("validate").exitCode).toBe(0); // delegated `hyperframes check` on the generated project
      expect(p.json("run", "motion-ref").exitCode).toBe(0);
      const v = await probeVideo(p.path("build/ref.mp4"));
      expect([v.frames, v.fps, v.width, v.height]).toEqual([72, 24, 640, 360]);
    } finally {
      p.cleanup();
    }
  }, 240_000);
});
