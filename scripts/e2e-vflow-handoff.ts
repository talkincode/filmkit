// Real cross-repository contracts, isolated loopback server (port 0), no production credentials/model calls.
// VFLOW_DIR=../vflow bun scripts/e2e-vflow-handoff.ts
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { main as consume } from "../tools/vflow/src/cli.ts";
import { parseBundle } from "../tools/vflow/src/bundle.ts";
import { media, project, probe } from "../tests/helpers.ts";

const root = resolve(process.env.VFLOW_DIR ?? "../vflow");
const at = (path: string) => import(pathToFileURL(join(root, path)).href);
const [{ createApiApp }, { VFlowClient }, auth, protocol, motionFixture] = await Promise.all([
  at("apps/api/src/app.ts"), at("packages/client/src/index.ts"), at("tests/e2e/auth-fixture.ts"),
  at("packages/protocol/src/index.ts"), at("tests/e2e/motion-fixture.ts"),
]);
const { app } = createApiApp(undefined, auth.TEST_AUTH_CONFIG);
const fetchFn = (url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(String(url), init));
const writer = new VFlowClient({ baseUrl: "http://localhost", headers: auth.WRITER_AUTH, fetchFn });
const reader = new VFlowClient({ baseUrl: "http://localhost", headers: { "CF-Access-Client-Id": "svc-token-observer", "CF-Access-Client-Secret": "svc-token-secret-1" }, fetchFn });
const source = project(), target = project();
const saved = { FILMKIT_HOME: process.env.FILMKIT_HOME, CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
try {
  process.env.FILMKIT_HOME = source.path("vault");
  process.env.CF_ACCESS_CLIENT_ID = "svc-token-observer";
  process.env.CF_ACCESS_CLIENT_SECRET = "svc-token-secret-1";
  await writer.createProject({ id: "handoff", name: "Synthetic handoff", members: { "agent-observer": "reader" } });
  await writer.getAuthoringWorkflow("handoff");
  media.mp4(source.path("video.mp4"), 3);
  media.wav(source.path("voice.wav"), 2, 880);
  media.wav(source.path("music.wav"), 3, 220);
  for (const [id, ext, mimeType] of [["video", "mp4", "video/mp4"], ["voice", "wav", "audio/wav"], ["music", "wav", "audio/wav"]]) {
    await writer.uploadAsset({ projectId: "handoff", assetId: id, bytes: readFileSync(source.path(`${id}.${ext}`)), mimeType });
  }
  await writer.createComposition({ projectId: "handoff", document: {
    apiVersion: "vflow/v1", project: "handoff", id: "cut", format: { width: 320, height: 180, fps: 24 }, sequence: ["first", "second"],
    shots: Object.fromEntries(["first", "second"].map((id) => [id, { description: id, durationFrames: 24, dependsOn: [], subjects: [], references: { images: [], videos: [] }, prompts: {}, candidates: { images: [], videos: [], audios: [] }, selected: { video: "video", audio: "voice" } }])),
    audioTracks: [{ id: "bgm", role: "bgm", asset: "music", startFrame: 12, durationFrames: 24, trimStartFrame: 24 }],
  } });
  const exported = await reader.exportCompositionBundle({ projectId: "handoff", compositionId: "cut", revision: 1, format: "json" });
  assert(protocol.inspectCompositionDelivery(exported.bundle.composition, exported.bundle.dependencies.assets).ready);
  const args = ["pull", "--base", `http://127.0.0.1:${server.port}`, "--project", "handoff", "--composition", "cut", "--revision", "1", "--mode", "assemble", "--out", target.path("filmkit.yaml"), "--json"];
  const pulled = await consume(args);
  assert.equal(pulled.exitCode, 0, pulled.stderr);
  const film = YAML.parse(readFileSync(target.path("filmkit.yaml"), "utf8"));
  assert.deepEqual(film.scenes.map((s: any) => film.metadata.annotations["vflow.shots"][s.id].shot), ["first", "second"]);
  const plan = target.json<any>("plan");
  assert.equal(plan.exitCode, 0, JSON.stringify(plan.err));
  assert.equal(plan.out.timeline.total, 2);
  assert.equal(plan.out.nodes.length, 1);
  assert(!existsSync(target.path(plan.out.nodes[0].produces.audio)), "pull must not execute crop");
  assert.equal(target.cli("run", plan.out.nodes[0].id).exitCode, 0);
  const built = target.json<any>("build");
  assert.equal(built.exitCode, 0, JSON.stringify(built.err));
  assert(Math.abs(probe(target.path(built.out.output)).duration - 2) < 1 / 24);
  assert.equal((await writer.getComposition("handoff", "cut")).headRevision, 1, "no remote writes during consumption");
  await assert.rejects(reader.patchComposition({ projectId: "handoff", compositionId: "cut", baseRevision: 1, operationId: "unauthorized", operations: [{ op: "update_shot_fields", shotId: "first", description: "not allowed" }] }), { code: "FORBIDDEN" });
  const info = await writer.getProjectOverview("handoff");
  await writer.setProjectMember({ projectId: "handoff", targetActorId: "agent-observer", role: null, baseRevision: info.project.membershipRevision ?? 0, operationId: "revoke-reader" });
  const before = readFileSync(target.path("filmkit.yaml"));
  const lock = readFileSync(target.path("filmkit.lock.yaml"));
  const refused = await consume([...args, "--force"]);
  assert.notEqual(refused.exitCode, 0);
  assert(before.equals(readFileSync(target.path("filmkit.yaml"))));
  assert(lock.equals(readFileSync(target.path("filmkit.lock.yaml"))));
  assert(!readdirSync(target.path("assets/vflow")).some((name) => name.startsWith(".pull-")));

  // Create an actual upstream-approved fixture with same-moment/different-purpose
  // frames. Synthetic review evidence is not a production visual approval.
  const seeded = await motionFixture.seedMotion(writer);
  const doc = structuredClone(seeded.motion.document);
  doc.id = "same-moment";
  delete doc.review;
  doc.keyframes[1].momentFrame = doc.keyframes[0].momentFrame;
  assert.deepEqual(protocol.structuralMaterialDiagnostics(doc), []);
  const approved = await motionFixture.approveMotion(writer, doc);
  await writer.patchComposition({ projectId: motionFixture.motionProject, compositionId: "main", baseRevision: 2, operationId: "same-moment-pin", operations: [{ op: "set_authoring", authoring: { policyVersion: protocol.AUTHORING_POLICY_VERSION, materials: [...seeded.document.authoring.materials, { id: doc.id, revision: approved.revision }] } }] });
  const motionExport = await writer.exportCompositionBundle({ projectId: motionFixture.motionProject, compositionId: "main", format: "json" });
  const parsed = parseBundle(motionExport);
  const first = parsed.motions[0]?.keyframes[0], second = parsed.motions[0]?.keyframes[1];
  assert(first && second);
  assert.equal(first.momentFrame, second.momentFrame);
  assert.notEqual(first.purpose, second.purpose);
  console.log("OK: real vflow strict project → read-only filmkit assembly → exact timeline/audio crop/build; revocation preserves local files; same-frame motion purposes agree");
} finally {
  server.stop(true);
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  target.cleanup(); source.cleanup();
}
