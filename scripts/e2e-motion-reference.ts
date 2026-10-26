// Cross-project integration, not part of bun test (requires a vflow checkout).
// Real vflow MCP/REST/domain + real assets + filmkit's read-only consumer.
// No production data, no provider/model calls, no real credentials.
// Usage: VFLOW_DIR=~/github/vflow bun scripts/e2e-motion-reference.ts
// Or use actually rendered artifacts: BLOCKOUT_MANIFEST=/path/manifest.json (render the supplied blockout-vflow-scene fixture first).
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { main as consume } from "../tools/vflow/src/cli.ts";
import { packageMotion } from "../tools/vflow/src/motion-package.ts";

const vflow = resolve(process.env.VFLOW_DIR ?? "../vflow");
const moduleAt = (path: string) => import(pathToFileURL(join(vflow, path)).href);
const [{ createApiApp }, { VFlowClient }, { TEST_AUTH_CONFIG, WRITER_AUTH, READER_AUTH }, { seedMotion, motionProject }] = await Promise.all([
  moduleAt("apps/api/src/app.ts"), moduleAt("packages/client/src/index.ts"),
  moduleAt("tests/e2e/auth-fixture.ts"), moduleAt("tests/e2e/motion-fixture.ts"),
]);
const { app } = createApiApp(undefined, TEST_AUTH_CONFIG);
const fetchFn = (url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(String(url), init));
const writer = new VFlowClient({ baseUrl: "http://localhost", headers: WRITER_AUTH, fetchFn });
const reader = new VFlowClient({ baseUrl: "http://localhost", headers: READER_AUTH, fetchFn });
async function seedRendered() {
  const { seedReferences } = await moduleAt("tests/e2e/reference-fixture.ts");
  const { REQUIRED_REVIEW_CHECKS, AUTHORING_POLICY_VERSION } = await moduleAt("packages/protocol/src/index.ts");
  const f = await seedReferences(writer);
  const manifestPath = resolve(process.env.BLOCKOUT_MANIFEST!);
  const packaged = await packageMotion(manifestPath, resolve("tools/vflow/test/fixtures/blockout-vflow-bindings.json"));
  for (const upload of packaged.uploads) await writer.uploadAsset({
    projectId: motionProject, assetId: upload.assetId,
    bytes: readFileSync(resolve(manifestPath, "..", upload.path)),
    expectedSha256: upload.sha256, mimeType: upload.mimeType,
    width: upload.width, height: upload.height, durationFrames: upload.durationFrames,
  });
  let rev = await writer.putAuthoringDocument({ projectId: motionProject, document: packaged.document, baseRevision: 0, operationId: "rendered-put" });
  rev = await writer.reviewAuthoringDocument({
    projectId: motionProject, id: packaged.document.id, baseRevision: rev.revision, operationId: "rendered-review", targets: ["$document"],
    review: { decision: "accepted", method: "external", reviewer: "fixture", evidence: "Local E2E fixture simulates completed visual review; real renderer checks frame count, hash and seek. This is NOT a production reference approval.", checks: Object.fromEntries(REQUIRED_REVIEW_CHECKS.motion_reference.map((name: string) => [name, "pass"])) },
  });
  rev = await writer.approveAuthoringDocument({ projectId: motionProject, id: packaged.document.id, baseRevision: rev.revision, operationId: "rendered-approve" });
  await writer.patchComposition({ projectId: motionProject, compositionId: "main", baseRevision: 1, operationId: "rendered-pin", operations: [{ op: "set_authoring", authoring: { policyVersion: AUTHORING_POLICY_VERSION, materials: [...f.document.authoring.materials, { id: packaged.document.id, revision: rev.revision }] } }] });
  return { ...f, request: { ...f.request, compositionRevision: 2, capabilities: { ...f.request.capabilities, motion: { video: { maxVideos: 1, usages: packaged.document.usage } } }, motion: { reference: { id: packaged.document.id, revision: rev.revision }, usage: packaged.document.usage, delivery: "video" } } };
}
const seeded = process.env.BLOCKOUT_MANIFEST ? await seedRendered() : await seedMotion(writer);
await reader.getAuthoringWorkflow(motionProject);
const { workflowContext } = await reader.callMcpTool("authoring_workflow_get", { projectId: motionProject });
// Production MCP entry, same domain and permissions as REST; context is explicit.
const prepared = await reader.callMcpTool("generation_inputs_prepare", { projectId: motionProject, workflowContext, request: seeded.request });
assert(prepared.packet, JSON.stringify(prepared.diagnostics));
const packet = prepared.packet;
assert.equal(packet.motion.delivery, "video");
assert.equal(packet.motion.reference.id, "spell-motion");
assert.equal(packet.motion.durationFrames, 96);
const actual = { delivery: "video", video: packet.motion.video };
const evidence = await writer.recordGenerationEvidence({
  projectId: motionProject, id: "cross-project-test", operationId: "cross-project-test",
  packet, actualInputs: packet.inputs.map(({ asset, sha256, role }: any) => ({ asset, sha256, role })),
  actualMotion: actual, outputs: ["panel-one"], method: "agent_reported",
  evidence: "Local integration fixture simulates a reported external run; no model was invoked, not a visual-quality approval.",
});
assert.equal(evidence.matchesPlan, true);
const other = await writer.recordGenerationEvidence({
  projectId: motionProject, id: "cross-project-missing", operationId: "cross-project-missing",
  packet, actualInputs: packet.inputs.map(({ asset, sha256, role }: any) => ({ asset, sha256, role })),
  outputs: ["panel-one"], method: "agent_reported", evidence: "No motion was actually reported.",
});
assert.equal(other.matchesPlan, false);
const dir = mkdtempSync(join(tmpdir(), "motion-cross-project-"));
const saved = { FILMKIT_HOME: process.env.FILMKIT_HOME, CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) });
try {
  process.env.FILMKIT_HOME = join(dir, "vault");
  // Test-only configured service identity is explicitly a member of the seeded project.
  process.env.CF_ACCESS_CLIENT_ID = "svc-token-client-1";
  process.env.CF_ACCESS_CLIENT_SECRET = "svc-token-secret-1";
  const result = await consume(["pull", "--project", motionProject, "--composition", "main", "--base", `http://127.0.0.1:${server.port}`, "--out", join(dir, "filmkit.yaml"), "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const film = YAML.parse(readFileSync(join(dir, "filmkit.yaml"), "utf8"));
  const notes = film.metadata.annotations["vflow.shots"].spell.motionReferences[0];
  assert.equal(notes.material.id, "spell-motion");
  assert.equal(notes.approval, "approved");
  for (const asset of Object.values<any>(film.assets)) assert(existsSync(resolve(dir, asset.uri)));
  assert(!existsSync(join(dir, "assets/spell.mp4")), "reference must not become final footage");
  assert.equal(notes.keyframes.length, 3);
  assert.equal(film.assets[notes.video.ref].kind, "video");
  assert.equal(film.assets[notes.source.ref].kind, "file");
  console.log("OK: vflow MCP prepare/evidence + REST export/bytes → filmkit video/keyframes/overview/source, no final footage promotion");
} finally {
  server.stop(true);
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
}
