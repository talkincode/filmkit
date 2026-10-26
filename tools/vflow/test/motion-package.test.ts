import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "bun";
import { project, media } from "../../../tests/helpers.ts";
import { main } from "../src/cli.ts";

function fixture() {
  const p = project();
  media.mp4(p.path("reference.mp4"), 0.5, { w: 64, h: 36 });
  media.png(p.path("overview.png"));
  writeFileSync(p.path("source.gz"), gzipSync(new TextEncoder().encode("source scene declaration")));
  const artifact = (role: string, path: string, mime: string, extra = {}) => {
    const bytes = readFileSync(p.path(path));
    return { role, path, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...extra };
  };
  const manifest = {
    schema: "blockout-manifest/v1alpha1",
    handoff: { complete: true, missing: [] },
    binding: { composition: { id: "main", revision: "1" }, shot: { id: "spell", revision: "1" }, scene: { id: "bridge", revision: "3" }, environment: { id: "weather-definition", revision: "2", variant: "night" }, subjects: [], props: [] },
    render: { width: 64, height: 36, fps: 24, durationFrames: 12 },
    verification: { seek: { identical: true, frames: [0] } },
    artifacts: [artifact("reference-video", "reference.mp4", "video/mp4"), artifact("overview", "overview.png", "image/png"), artifact("keyframe", "overview.png", "image/png", { frame: 0 }), artifact("source-archive", "source.gz", "application/gzip")],
  };
  const binding: Record<string, any> = { id: "motion", title: "White-model blocking", compositionId: "main", compositionRevision: 1, shotId: "spell", scene: { id: "bridge", revision: 3 }, environmentVariant: "night", subjects: [], usage: ["blocking"], provenance: "Local acceptance fixture, externally rendered" };
  const write = () => { p.write("manifest.json", JSON.stringify(manifest)); p.write("binding.json", JSON.stringify(binding)); };
  write();
  const args = ["package-motion", p.path("manifest.json"), "--binding", p.path("binding.json"), "--json"];
  return { p, manifest, binding, write, args };
}

test("package-motion verifies real media and explicit pins and produces an unreviewed upload/document handoff", async () => {
  const f = fixture();
  try {
    const r = await main(f.args);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.document).toMatchObject({ kind: "motion_reference", compositionId: "main", compositionRevision: 1, shotId: "spell", fps: 24, durationFrames: 12, usage: ["blocking"] });
    expect(out.document.review).toBeUndefined();
    expect(out.document.status).toBeUndefined();
    expect(out.document.keyframes[0]).toMatchObject({ momentFrame: 0, purpose: "blocking" });
    expect(out.uploads).toHaveLength(4); // roles/moments remain distinct even when image bytes coincide
    expect(out.uploads.every((u: any) => u.assetId.endsWith(u.sha256))).toBe(true);
    expect(out.document.overview.asset).not.toBe(out.document.keyframes[0].asset);
    expect(out.warning).toContain("does not approve");
  } finally { f.p.cleanup(); }
});

test("package-motion refuses target or subject drift, bad source hash and absent seek validation", async () => {
  const f = fixture();
  try {
    f.binding.shotId = "another-shot"; f.write();
    expect((await main(f.args)).exitCode).toBe(2);
    f.binding.shotId = "spell";
    f.binding.subjects = [{kind: "character", id: "new-person", revision: 1, variant: "default"}]; f.write();
    expect((await main(f.args)).stderr).toContain("binding.subjects");
    f.binding.subjects = []; f.write();
    writeFileSync(f.p.path("source.gz"), "tampered bytes");
    expect((await main(f.args)).stderr).toContain("do not match");
    f.manifest.verification.seek.identical = false; f.write();
    expect((await main(f.args)).stderr).toContain("seek verification");
  } finally { f.p.cleanup(); }
});

test("upstream binding input rejects URLs, extra scene fields and oversized titles before writing a document", async () => {
  const f = fixture();
  try {
    f.binding.id = "https://mutable-reference.invalid"; f.write();
    expect((await main(f.args)).exitCode).toBe(2);
    f.binding.id = "motion";
    f.binding.scene.unknown = true; f.write();
    expect((await main(f.args)).exitCode).toBe(2);
    delete f.binding.scene.unknown;
    f.binding.title = "x".repeat(301); f.write();
    expect((await main(f.args)).stderr).toContain("field limit");
  } finally { f.p.cleanup(); }
});

test("complete rendered bindings map scene, environment variant and role without mistaking geometry kind for identity kind", async () => {
  const f = fixture();
  try {
    f.manifest.binding.subjects.push({ id: "proxy", bindingId: "actor", revision: "7", role: "character", kind: "capsule", variant: "apron" } as never);
    delete f.binding.compositionId; delete f.binding.compositionRevision; delete f.binding.shotId;
    delete f.binding.scene; delete f.binding.environmentVariant; delete f.binding.subjects;
    f.write();
    const r = await main(f.args);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout).document;
    expect(doc).toMatchObject({ compositionId: "main", compositionRevision: 1, shotId: "spell", scene: {id: "bridge", revision: 3}, environmentVariant: "night" });
    expect(doc.subjects).toEqual([{ kind: "character", id: "actor", revision: 7, variant: "apron" }]);
    f.binding.environmentVariant = "day"; f.write();
    expect((await main(f.args)).stderr).toContain("binding.environmentVariant");
  } finally { f.p.cleanup(); }
});

test("an incomplete or contradictory handoff cannot be repaired by supplying missing bindings externally", async () => {
  const f = fixture();
  try {
    f.manifest.handoff = { complete: false, missing: ["binding.scene", "subjects[0].binding.variant"] as never[] }; f.write();
    const r = await main(f.args);
    expect(r.exitCode).toBe(2);
    const errors = JSON.parse(r.stderr).errors;
    expect(errors.map((e: {field: string}) => e.field)).toEqual(["manifest.binding.scene", "manifest.subjects[0].binding.variant"]);
    f.manifest.handoff = { complete: true, missing: [] };
    f.manifest.binding.scene = undefined as never; f.write();
    expect((await main(f.args)).exitCode).toBe(2); // environment.id must not be used as a scene fallback
  } finally { f.p.cleanup(); }
});

test("multiple usage types require explicit per-frame purposes instead of arbitrarily guessing", async () => {
  const f = fixture();
  try {
    f.binding.usage = ["camera_motion", "blocking"]; f.write();
    expect((await main(f.args)).stderr).toContain("explicit purpose");
    f.binding.keyframeUsages = [{momentFrame: 0, purpose: "blocking"}]; f.write();
    const r = await main(f.args);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.document.keyframes[0].purpose).toBe("blocking");
    expect(out.document.keyframeUsages).toBeUndefined();
  } finally { f.p.cleanup(); }
});

test("package-motion refuses overwrite and a failed verification leaves an existing handoff untouched", async () => {
  const f = fixture();
  try {
    f.p.write("package.json", "my existing handoff");
    const args = [...f.args, "--out", f.p.path("package.json")];
    expect((await main(args)).exitCode).toBe(1);
    expect(readFileSync(f.p.path("package.json"), "utf8")).toBe("my existing handoff");
    f.manifest.render.durationFrames = 24; f.write();
    const r = await main([...args, "--force"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("decoded video differs");
    expect(readFileSync(f.p.path("package.json"), "utf8")).toBe("my existing handoff");
  } finally { f.p.cleanup(); }
});
