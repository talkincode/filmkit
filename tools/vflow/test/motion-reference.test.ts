// Consumer boundary: reference videos are inputs, never final clips or identity images.
import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { parseBundle } from "../src/bundle.ts";
import { convertBundle } from "../src/convert.ts";
import { project, media } from "../../../tests/helpers.ts";
import { main } from "../src/cli.ts";
import { startStub, sha256, TOKEN } from "./stub-vflow.ts";
import { commitFiles } from "../src/transaction.ts";

const demo = () => JSON.parse(readFileSync(new URL("./fixtures/vflow-v1-demo.bundle.json", import.meta.url), "utf8"));

// Integrity-critical batch installation seam: real failed rename after existing
// files have been backed up must restore both originals, not just delete new files.
test("a late install failure restores existing assets and documents", () => {
  const p = project();
  try {
    p.write("staging/new", "new bytes");
    p.write("asset", "old asset"); p.write("filmkit.yaml", "old film");
    expect(() => commitFiles([
      { source: p.path("staging/new"), target: p.path("asset") },
      { source: p.path("staging/missing"), target: p.path("filmkit.yaml") },
    ], p.path("staging"))).toThrow("cannot install");
    expect(readFileSync(p.path("asset"), "utf8")).toBe("old asset");
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe("old film");
  } finally { p.cleanup(); }
});

test("offline CLI conversion keeps a reference video as a video asset, with purpose and notes, not as produces", () => {
  const raw = demo();
  raw.dependencies.assets.push({ id: "blocking-video", sha256: "b".repeat(64), mimeType: "video/mp4", sizeBytes: 100 });
  raw.composition.shots["shot-001"].references.videos = [{ asset: "blocking-video", role: "blocking", notes: "white model: motion only, not identity" }];
  const conversion = convertBundle(parseBundle(raw), "demo");
  const film = YAML.parse(conversion.yaml);
  expect(film.assets["ref-blocking-video"]).toEqual({ uri: `./assets/vflow/${"b".repeat(16)}.mp4`, kind: "video" });
  expect(film.scenes[0].intent.references).toContain("ref-blocking-video");
  expect(film.scenes[0].produces.video).toBe("./assets/shot-001.mp4");
  expect(film.metadata.annotations["vflow.shots"]["shot-001"].referenceVideos).toEqual([
    { ref: "ref-blocking-video", asset: "blocking-video", role: "blocking", notes: "white model: motion only, not identity", approval: "unverified" },
  ]);
  expect(conversion.fetch.find((i) => i.assetId === "blocking-video")?.targets).toEqual([`./assets/vflow/${"b".repeat(16)}.mp4`]);
  expect(conversion.ignored).not.toContain("references.videos: 1");
  const p = project();
  try {
    p.write("filmkit.yaml", conversion.yaml);
    const r = p.json("plan");
    expect(r.exitCode).toBe(0);
    expect(JSON.stringify(r.out)).toContain("blocking");
  } finally { p.cleanup(); }
});

test("a malformed reference video is refused at the consumed field, without promoting image input", () => {
  const raw = demo();
  raw.composition.shots["shot-001"].references.videos = [{ asset: "preview-png", role: "camera_motion" }];
  expect(() => convertBundle(parseBundle(raw), "demo")).toThrow("must be a video");
});

test("vflow's real approved-material export including its composition baseline is consumed without a vendor SDK", () => {
  const raw = readFileSync(new URL("./fixtures/vflow-v2-motion.bundle.json", import.meta.url), "utf8");
  const conversion = convertBundle(parseBundle(raw), "reference-test/main@2");
  const film = YAML.parse(conversion.yaml);
  const scene = film.scenes.find((s: {id: string}) => s.id === "spell");
  const motion = film.metadata.annotations["vflow.shots"].spell.motionReferences[0];
  expect(motion.material).toEqual({ id: "spell-motion", revision: 3 });
  expect(motion.scene).toEqual({ id: "bridge", revision: 3 });
  expect(motion.fps).toBe(24); // actual video fps differs from the 30fps composition, both four seconds
  expect(motion.durationFrames).toBe(96);
  expect(scene.duration).toBe(4);
  expect(scene.produces.video).toBe("./assets/spell.mp4");
  expect(scene.intent.references).toContain("ref-mo-video");
  expect(scene.intent.references).not.toContain("ref-mo-source");
  expect(conversion.fetch.find((f) => f.assetId === "mo-video")?.mimeType).toBe("video/mp4");
});

function approvedMotionBundle() {
  const raw = demo();
  raw.apiVersion = raw.composition.apiVersion = "vflow/v2";
  const baseline = structuredClone(raw.composition);
  raw.revision = 2;
  raw.composition.authoring = { policyVersion: "reference-authoring/1", materials: [{ id: "mo", revision: 3 }] };
  const doc = {
    schemaVersion: "vflow/reference-workflow/v1", kind: "motion_reference", id: "mo", title: "Camera orbit",
    compositionId: "episode-001", compositionRevision: 1, shotId: "shot-001",
    scene: { id: "room", revision: 1 }, environmentVariant: "day",
    subjects: [{ kind: "character", id: "character-main", revision: 1, variant: "raincoat" }],
    fps: 24, durationFrames: 72, usage: ["camera_motion", "blocking"], provenance: "external Three.js white-model render",
    video: { asset: "mo-video" }, overview: { asset: "mo-overview" }, source: { asset: "mo-source" },
    keyframes: [{ id: "middle", asset: "mo-kf", momentFrame: 36, purpose: "blocking", note: "hand on cup" }],
    review: { decision: "accepted", method: "human", reviewer: "fixture", evidence: "Full playback checked", checks: { blocking: "pass" } },
  };
  raw.dependencies.materials = [{ projectId: "demo", revision: 3, status: "approved", actorId: "fixture", createdAt: "2026-10-01T00:00:00Z", operationId: "approve", document: doc }];
  raw.dependencies.compositionBaselines = [{ id: "episode-001", revision: 1, document: baseline }];
  for (const [id, mimeType, hex] of [["mo-video", "video/mp4", "a"], ["mo-overview", "image/png", "b"], ["mo-source", "application/zip", "c"], ["mo-kf", "image/png", "d"]]) {
    raw.dependencies.assets.push({ id, mimeType, sha256: hex!.repeat(64), sizeBytes: 10 });
  }
  return raw;
}

test("a pinned approved dynamic reference delivers video, keyframes, overview and source without inventing final footage", () => {
  const conversion = convertBundle(parseBundle(approvedMotionBundle()), "demo");
  const film = YAML.parse(conversion.yaml);
  const motion = film.metadata.annotations["vflow.shots"]["shot-001"].motionReferences[0];
  expect(motion).toMatchObject({ material: { id: "mo", revision: 3 }, approval: "approved", fps: 24, durationFrames: 72, purpose: ["camera_motion", "blocking"] });
  expect(motion.keyframes[0]).toMatchObject({ momentFrame: 36, purpose: "blocking", note: "hand on cup" });
  expect(film.scenes[0].intent.references).toContain("ref-mo-video");
  expect(film.scenes[0].intent.references).not.toContain("ref-mo-source");
  expect(film.scenes[0].intent.references).not.toContain("ref-mo-overview");
  expect(film.assets["ref-mo-source"].kind).toBe("file");
  expect(film.scenes[0].produces.video).toBe("./assets/shot-001.mp4");
  expect(conversion.fetch.map((f) => f.assetId)).toEqual(expect.arrayContaining(["mo-video", "mo-overview", "mo-source", "mo-kf"]));
});

test("candidate dynamic references are not treated as approved, and unpinned revisions are ignored", () => {
  const raw = approvedMotionBundle();
  raw.dependencies.materials[0].status = "candidate";
  const candidate = convertBundle(parseBundle(raw), "demo");
  expect(candidate.warnings.join(" ")).toContain("not approved");
  expect(candidate.fetch.some((f) => f.assetId === "mo-video")).toBe(false);
  raw.composition.authoring.materials[0].revision = 4;
  raw.dependencies.materials[0].status = "approved";
  expect(convertBundle(parseBundle(raw), "demo").fetch.some((f) => f.assetId === "mo-video")).toBe(false);
});

test("missing baseline, changed shot, missing asset and wrong identity purpose fail at their exact input field", () => {
  const missing = approvedMotionBundle();
  missing.dependencies.compositionBaselines = [];
  expect(() => parseBundle(missing)).toThrow("baseline is missing");
  const drifted = approvedMotionBundle();
  drifted.composition.shots["shot-001"].description = "a different action";
  expect(() => parseBundle(drifted)).toThrow("has drifted");
  const asset = approvedMotionBundle();
  asset.dependencies.assets = asset.dependencies.assets.filter((a: {id: string}) => a.id !== "mo-source");
  expect(() => convertBundle(parseBundle(asset), "demo")).toThrow("not in the bundle's asset manifest");
  const misuse = approvedMotionBundle();
  misuse.dependencies.materials[0].document.keyframes[0].purpose = "face_identity";
  expect(() => parseBundle(misuse)).toThrow("cannot be identity");
});

test("candidate/selected results do not invalidate the design baseline, but a new pinned scene does", () => {
  const raw = approvedMotionBundle();
  raw.composition.shots["shot-001"].candidates.videos.push({ asset: "a-new-result" });
  raw.composition.shots["shot-001"].selected.audio = "a-new-voice-result";
  expect(parseBundle(raw).motions).toHaveLength(1);
  raw.composition.authoring.materials.push({ id: "room", revision: 2 });
  expect(() => parseBundle(raw)).toThrow("scene revision differs");
});

test("white-model reference selected as final footage is explicitly refused, not silently built", () => {
  const raw = approvedMotionBundle();
  raw.composition.shots["shot-001"].selected.video = "mo-video";
  // Keep baseline identical to prove the misuse check, not the drift predicate, is exercised.
  raw.dependencies.compositionBaselines[0].document.shots["shot-001"].selected.video = "mo-video";
  expect(() => convertBundle(parseBundle(raw), "demo")).toThrow("cannot be selected as final footage");
});

test("pull downloads a real white-model reference clip as input; failure leaves film and lock unchanged", async () => {
  const p = project();
  const home = mkdtempSync(join(tmpdir(), "motion-pull-home-"));
  const saved = { home: process.env.FILMKIT_HOME, id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET };
  process.env.FILMKIT_HOME = home;
  process.env.CF_ACCESS_CLIENT_ID = TOKEN.id;
  process.env.CF_ACCESS_CLIENT_SECRET = TOKEN.secret;
  let stub: Awaited<ReturnType<typeof startStub>> | undefined;
  try {
    media.mp4(p.path("white.mp4"), 0.5);
    const bytes = readFileSync(p.path("white.mp4"));
    const raw = demo();
    raw.composition.sequence = ["shot-001"];
    raw.composition.shots["shot-001"].references = { images: [], videos: [{ asset: "motion", role: "camera_motion" }] };
    raw.composition.shots["shot-001"].candidates.images = [];
    raw.composition.shots["shot-001"].subjects = [];
    raw.dependencies.assets.push({ id: "motion", sha256: sha256(bytes), mimeType: "video/mp4", sizeBytes: bytes.length });
    stub = await startStub({ bundle: raw, assets: { motion: bytes }, project: "demo", composition: "episode-001" });
    const argv = ["pull", "--base", stub.url, "--project", "demo", "--composition", "episode-001", "--out", p.path("filmkit.yaml"), "--json"];
    const success = await main(argv);
    expect(success.exitCode).toBe(0);
    const filmBefore = readFileSync(p.path("filmkit.yaml"));
    expect(existsSync(p.path(`assets/vflow/${sha256(bytes).slice(0, 16)}.mp4`))).toBe(true);
    expect(existsSync(p.path("assets/shot-001.mp4"))).toBe(false);
    expect(p.json("plan").exitCode).toBe(0);
    expect(p.json("storyboard").exitCode).toBe(0);
    expect(readFileSync(p.path("build/storyboard.html"), "utf8")).toContain("<video");
    p.write("filmkit.lock.yaml", "lock-before\n");
    // Remove only fetched reference to force network retrieval, corrupt its bytes at the source.
    rmSync(p.path(`assets/vflow/${sha256(bytes).slice(0, 16)}.mp4`));
    stub.behavior.corrupt = "motion";
    const failure = await main([...argv, "--force"]);
    expect(failure.exitCode).toBe(4);
    expect(readFileSync(p.path("filmkit.yaml"))).toEqual(filmBefore);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe("lock-before\n");
    expect(existsSync(p.path(`assets/vflow/${sha256(bytes).slice(0, 16)}.mp4`))).toBe(false);
    // Simulate a filesystem failure AFTER the verified assets begin installation:
    // a regular file occupies the document-record parent directory.
    stub.behavior.corrupt = undefined;
    rmSync(p.path("vflow"), { recursive: true, force: true });
    p.write("vflow", "do not replace this file");
    const blocked = await main([...argv, "--force"]);
    expect(blocked.exitCode).toBe(1);
    expect(readFileSync(p.path("filmkit.yaml"))).toEqual(filmBefore);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe("lock-before\n");
    expect(readFileSync(p.path("vflow"), "utf8")).toBe("do not replace this file");
    expect(existsSync(p.path(`assets/vflow/${sha256(bytes).slice(0, 16)}.mp4`))).toBe(false);
  } finally {
    stub?.stop();
    for (const [key, value] of Object.entries({ FILMKIT_HOME: saved.home, CF_ACCESS_CLIENT_ID: saved.id, CF_ACCESS_CLIENT_SECRET: saved.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    p.cleanup(); rmSync(home, { recursive: true, force: true });
  }
});
