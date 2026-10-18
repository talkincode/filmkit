// A released template `@N` is immutable (PLAN §6.1): its files feed every cache
// key, so editing one silently orphans (or worse, mis-serves) cached clips.
// Changing any of these hashes means: create h3-ref2va@2 instead.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "../src/canonical.ts";
import { TEMPLATES_ROOT } from "../src/workflow.ts";
import { tpl } from "./support.ts";

const dir = join(TEMPLATES_ROOT, "h3-ref2va@1");

describe("template h3-ref2va@1 is frozen", () => {
  const snapshot: Record<string, string> = {
    "bindings.json": "5f4214b8d43c5a3bea81592c8cf2f93943fb408d59a87903d44c30dccb6bfbee",
    "dense.api.json": "ff0c14e57846842845e80ea37cb16dc8df622140763931967fb759bd0d4ec70c",
    "manifest.json": "5adcbd98c3310ee52e259b77ca9e3b74b379219d370e099ce6c7d10489d307a9",
    "object_info.snapshot.json": "618275f64542831729c6857ff480f4e3e28e34b1e05c5e0547a3b24a44f361ff",
    "vsa.api.json": "c4c721bf4e784964caa66fd1817eee0e84ca4177b3cd2f7d4c918af7df59da93",
  };

  test("exactly these files, with exactly these hashes", () => {
    expect(readdirSync(dir).sort()).toEqual(Object.keys(snapshot));
    for (const [file, sha] of Object.entries(snapshot)) expect([file, sha256File(join(dir, file))]).toEqual([file, sha]);
  });

  test("the loaded template reports the same file hashes", () => {
    expect(tpl.variants.dense.fileSha256).toBe(snapshot["dense.api.json"]!);
    expect(tpl.variants.vsa.fileSha256).toBe(snapshot["vsa.api.json"]!);
    expect(tpl.bindingsSha256).toBe(snapshot["bindings.json"]!);
  });

  test("workflow invariants the bindings rely on", () => {
    const { dense, vsa } = tpl.variants;
    // dense has no gate node; vsa wires 143 -> 144 -> 142 (the only structural difference, PLAN D5)
    expect(dense.workflow["144"]).toBeUndefined();
    expect(dense.workflow["142"]!.inputs.model).toEqual(["143", 0]);
    expect(vsa.workflow["144"]!.class_type).toBe("Ref2VAVSAGatePatch");
    expect(vsa.workflow["144"]!.inputs.model).toEqual(["143", 0]);
    expect(vsa.workflow["142"]!.inputs.model).toEqual(["144", 0]);
    for (const v of [dense, vsa]) {
      expect(v.workflow["50"]!.inputs.image).toBe("ref_placeholder.png");
      expect(v.workflow["16"]!.inputs.filename_prefix).toBe("fk/out");
      expect(v.workflow["6"]!.inputs["ref_images.ref_image_0"]).toEqual(["50", 0]);
    }
    const classes = new Set(Object.values(vsa.workflow).map((n) => n.class_type));
    for (const c of tpl.bindings.requiredClasses) expect(classes.has(c)).toBe(true);
  });

  test("object_info snapshot carries the M0 constraints", () => {
    const c = tpl.objectInfo.classes;
    expect(c.MiniMaxH3ReferenceToVideo.inputs.length).toEqual({ min: 5, max: 3600, step: 17, type: "INT" } as never);
    expect(c.MiniMaxH3ReferenceToVideo.inputs.width).toMatchObject({ min: 32, step: 32 });
    expect(c.MiniMaxH3ReferenceToVideo.inputs.height).toMatchObject({ min: 32, step: 32 });
    expect(c.Ref2VAVSAGatePatch.inputs.sparsity).toMatchObject({ min: 0, max: 0.98 });
    expect((c.MiniMaxH3ReferenceToVideo.inputs as unknown as Record<string, { max?: number }>).ref_images!.max).toBe(9);
  });
});
