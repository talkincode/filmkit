// Offline handoff: a verified external blockout bundle + explicit vflow bindings
// -> an unreviewed motion_reference candidate and an upload manifest. This never
// writes to vflow, never invents scene/subject bindings, and never approves media.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { probeVideo } from "../../blockout/src/media.ts";
import { BlockoutError } from "../../blockout/src/errors.ts";
import { fail, invalid, io, PullError } from "./errors.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const pos = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const stableId = (v: unknown): v is string => text(v) && v.length <= 200 && !/^https?:/i.test(v) && !v.includes("::");
const exactKeys = (value: Obj, keys: string[]) => Object.keys(value).every((k) => keys.includes(k));
const allowedUsage = ["camera_motion", "blocking", "action_timing", "framing"];
function readJson(path: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (err) { return fail(io(`cannot read ${path}: ${(err as Error).message}`)); }
  try { return JSON.parse(raw); } catch { return fail(invalid(`not valid JSON: ${path}`)); }
}

export async function packageMotion(manifestPath: string, bindingPath: string) {
  const manifest = readJson(manifestPath);
  const binding = readJson(bindingPath);
  const bad = (field: string, message: string): never => fail(invalid(message, { field }));
  if (!obj(manifest) || manifest.schema !== "blockout-manifest/v1alpha1") bad("manifest.schema", "expected blockout-manifest/v1alpha1");
  const m = manifest as Obj;
  if (!obj(binding)) bad("binding", "expected explicit vflow bindings");
  const b = binding as Obj;
  const keys = ["id", "title", "compositionId", "compositionRevision", "shotId", "scene", "environmentVariant", "subjects", "usage", "provenance", "keyframeUsages"];
  if (Object.keys(b).some((k) => !keys.includes(k))) bad("binding", "unknown binding field");
  for (const key of ["id", "title", "compositionId", "shotId", "environmentVariant", "provenance"]) if (!text(b[key])) bad(`binding.${key}`, "required non-empty string");
  for (const key of ["id", "compositionId", "shotId", "environmentVariant"]) if (!stableId(b[key])) bad(`binding.${key}`, "must be a stable local id (no URL or composite key)");
  if ((b.title as string).length > 300 || (b.provenance as string).length > 4000) bad("binding", "title/provenance exceeds the vflow field limit");
  if (!pos(b.compositionRevision) || !obj(b.scene) || !exactKeys(b.scene, ["id", "revision"]) || !stableId(b.scene.id) || !pos(b.scene.revision)) bad("binding.scene", "scene and composition need positive fixed revisions");
  if (!Array.isArray(b.subjects) || b.subjects.length > 50 || !b.subjects.every((s) => obj(s) && exactKeys(s, ["kind", "id", "revision", "variant"]) && ["character", "prop"].includes(String(s.kind)) && stableId(s.id) && pos(s.revision) && stableId(s.variant))) bad("binding.subjects", "every subject needs kind, id, revision and explicit variant");
  if (!Array.isArray(b.usage) || !b.usage.length || !b.usage.every((u) => allowedUsage.includes(String(u))) || new Set(b.usage).size !== b.usage.length) bad("binding.usage", "choose unique motion-only usages");
  const declared = obj(m.binding) ? m.binding : {};
  const composition = obj(declared.composition) ? declared.composition : {};
  const shot = obj(declared.shot) ? declared.shot : {};
  if (composition.id !== b.compositionId || String(composition.revision) !== String(b.compositionRevision) || shot.id !== b.shotId) bad("binding.compositionId", "vflow target differs from the rendered bundle's composition/shot binding");
  const geometry = obj(declared.environment) ? declared.environment : obj(declared.scene) ? declared.scene : undefined;
  if (!geometry || geometry.id !== (b.scene as Obj).id || String(geometry.revision) !== String((b.scene as Obj).revision)) bad("binding.scene", "scene geometry binding differs from the rendered bundle");
  const owners = [
    ...(Array.isArray(declared.subjects) ? declared.subjects.filter(obj).map((s) => ({ kind: "character", id: s.bindingId, revision: s.revision })) : []),
    ...(Array.isArray(declared.props) ? declared.props.filter(obj).map((s) => ({ kind: "prop", id: s.bindingId, revision: s.revision })) : []),
  ];
  const signature = (s: Obj) => `${s.kind}:${s.id}@${s.revision}`;
  if (JSON.stringify(owners.map(signature).sort()) !== JSON.stringify((b.subjects as Obj[]).map(signature).sort())) bad("binding.subjects", "vflow subject set differs from the rendered bundle");
  const timing = obj(m.render) ? m.render : {};
  const verification = obj(m.verification) ? m.verification : {};
  if (!pos(timing.fps) || timing.fps > 240 || !pos(timing.durationFrames) || !obj(verification.seek) || verification.seek.identical !== true || !Array.isArray(verification.seek.frames) || verification.seek.frames.length === 0) bad("manifest.verification", "render must have fixed timing and successful non-empty seek verification");
  if (!Array.isArray(m.artifacts)) bad("manifest.artifacts", "missing artifacts");
  const root = realpathSync(dirname(resolve(manifestPath)));
  const uploads: { assetId: string; path: string; mimeType: string; sha256: string; sizeBytes: number; width?: number; height?: number; durationFrames?: number }[] = [];
  const byRole: Record<string, { asset: string; frame?: number }[]> = {};
  for (const [i, item] of (m.artifacts as unknown[]).entries()) {
    if (!obj(item) || !text(item.path) || !text(item.role) || !text(item.mime)) bad(`manifest.artifacts[${i}]`, "artifact needs path, role and mime");
    const a = item as Obj;
    if (isAbsolute(a.path as string)) bad(`manifest.artifacts[${i}].path`, "artifact path must be bundle-relative");
    let path: string;
    try { path = realpathSync(resolve(root, a.path as string)); } catch { return fail(io(`artifact not found: ${String(a.path)}`)); }
    if (relative(root, path!).startsWith("..") || isAbsolute(relative(root, path!))) bad(`manifest.artifacts[${i}].path`, "artifact escapes the rendered bundle");
    const bytes = readFileSync(path!);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (a.sha256 !== hash || a.size !== bytes.length) bad(`manifest.artifacts[${i}].sha256`, "artifact bytes do not match the render manifest");
    // Different semantic roles/moments need distinct stable IDs even when their
    // pixels coincide (vflow deliberately disallows overview/keyframe identity aliasing).
    const roleKey = a.role === "keyframe" ? `keyframe-${String(a.frame)}` : String(a.role);
    if (!["reference-video", "overview", "keyframe", "source-archive"].includes(String(a.role))) bad(`manifest.artifacts[${i}].role`, "unknown artifact role");
    const assetId = `blockout-${roleKey}-${hash}`;
    const existing = uploads.find((u) => u.assetId === assetId);
    if (existing && existing.mimeType !== a.mime) bad(`manifest.artifacts[${i}].mime`, "same bytes have conflicting MIME declarations");
    if (!existing) uploads.push({ assetId, path: a.path as string, mimeType: a.mime as string, sha256: hash, sizeBytes: bytes.length, ...(pos(a.width) ? { width: a.width } : {}), ...(pos(a.height) ? { height: a.height } : {}), ...(a.role === "reference-video" ? { durationFrames: timing.durationFrames as number } : {}) });
    (byRole[a.role as string] ??= []).push({ asset: assetId, ...(typeof a.frame === "number" ? { frame: a.frame } : {}) });
  }
  for (const role of ["reference-video", "overview", "source-archive"]) if (byRole[role]?.length !== 1) bad(`manifest.artifacts.${role}`, "exactly one artifact is required");
  const videoUpload = uploads.find((u) => u.assetId === byRole["reference-video"]![0]!.asset)!;
  if (!videoUpload.mimeType.startsWith("video/")) bad("manifest.artifacts.reference-video", "reference video needs video MIME");
  let facts;
  try { facts = await probeVideo(resolve(root, videoUpload.path)); }
  catch (err) { if (err instanceof BlockoutError) throw new PullError(err.details); throw err; }
  if (facts.frames !== timing.durationFrames || facts.fps !== timing.fps || facts.width !== timing.width || facts.height !== timing.height) bad("manifest.render", "decoded video differs from declared timing or dimensions");
  const frameUses = Array.isArray(b.keyframeUsages) ? b.keyframeUsages : [];
  if ((b.usage as string[]).length > 1 && !frameUses.length) bad("binding.keyframeUsages", "multiple motion usages require an explicit purpose for each keyframe");
  const keyframes = (byRole.keyframe ?? []).map((f) => {
    if (f.frame === undefined || !Number.isInteger(f.frame) || f.frame < 0 || f.frame >= (timing.durationFrames as number)) bad("manifest.artifacts.keyframe", "invalid keyframe moment");
    const purpose = frameUses.filter(obj).find((k) => k.momentFrame === f.frame)?.purpose ?? ((b.usage as string[]).length === 1 ? (b.usage as string[])[0] : undefined);
    if (!allowedUsage.includes(String(purpose)) || !(b.usage as string[]).includes(String(purpose))) bad("binding.keyframeUsages", `keyframe ${f.frame} needs an explicitly declared motion purpose`);
    return { id: `frame-${f.frame}`, asset: f.asset, momentFrame: f.frame, purpose: purpose as string };
  });
  if (!keyframes.length || new Set(keyframes.map((f) => f.id)).size !== keyframes.length) bad("manifest.artifacts.keyframe", "need unique, explicit keyframe moments");
  return {
    document: {
      schemaVersion: "vflow/reference-workflow/v1", kind: "motion_reference",
      id: b.id as string, title: b.title as string, compositionId: b.compositionId as string,
      compositionRevision: b.compositionRevision as number, shotId: b.shotId as string,
      scene: b.scene as { id: string; revision: number }, environmentVariant: b.environmentVariant as string,
      subjects: b.subjects as { kind: string; id: string; revision: number; variant: string }[],
      usage: b.usage as string[], provenance: b.provenance as string,
      fps: timing.fps as number, durationFrames: timing.durationFrames as number,
      video: { asset: byRole["reference-video"]![0]!.asset }, overview: { asset: byRole.overview![0]!.asset }, source: { asset: byRole["source-archive"]![0]!.asset }, keyframes,
    },
    uploads,
    warning: "Unreviewed candidate only: upload assets, then use vflow put/review/approve. This package does not approve or send model inputs.",
  };
}
