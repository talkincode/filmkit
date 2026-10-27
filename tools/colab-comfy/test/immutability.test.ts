// A released template `@N` is immutable (PLAN §6.1): its files feed every cache
// key, so editing one silently orphans (or worse, mis-serves) cached clips.
// Changing any of these hashes means: create h3-ref2va@2 instead.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "../src/canonical.ts";
import { TEMPLATES_ROOT } from "../src/workflow.ts";
import { tpl, tpl2, tplF } from "./support.ts";

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
    expect(tpl.variants.vsa!.fileSha256).toBe(snapshot["vsa.api.json"]!);
    expect(tpl.bindingsSha256).toBe(snapshot["bindings.json"]!);
  });

  test("workflow invariants the bindings rely on", () => {
    const { dense } = tpl.variants;
    const vsa = tpl.variants.vsa!;
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
    const c = tpl.objectInfo.classes as any;
    expect(c.MiniMaxH3ReferenceToVideo.inputs.length).toEqual({ min: 5, max: 3600, step: 17, type: "INT" } as never);
    expect(c.MiniMaxH3ReferenceToVideo.inputs.width).toMatchObject({ min: 32, step: 32 });
    expect(c.MiniMaxH3ReferenceToVideo.inputs.height).toMatchObject({ min: 32, step: 32 });
    expect(c.Ref2VAVSAGatePatch.inputs.sparsity).toMatchObject({ min: 0, max: 0.98 });
    expect((c.MiniMaxH3ReferenceToVideo.inputs as unknown as Record<string, { max?: number }>).ref_images!.max).toBe(9);
  });
});

// h3-ref2va@2 = @1 + the audioGuide binding (MiniMaxH3AddGuide lip sync). Same workflows, same models and pins;
// only bindings.json (audioGuide, template name), manifest.json (template name) and the object_info snapshot
// (the two guide classes) differ. Frozen from its first release, like @1.
describe("template h3-ref2va@2 is frozen", () => {
  const dir2 = join(TEMPLATES_ROOT, "h3-ref2va@2");
  const snapshot: Record<string, string> = {
    "bindings.json": "0ca1cb6da379a97a74be9ba9b142d1fc8a8ed57ae995c6dc62ca4b19382085cd",
    "dense.api.json": "ff0c14e57846842845e80ea37cb16dc8df622140763931967fb759bd0d4ec70c",
    "manifest.json": "0ac044ad6df429edd6addaae7f04c069f847af2e652bfcd76ff7d7c3ed5c6c01",
    "object_info.snapshot.json": "925ee0a4f30532ad8cb7098a7b8a89307443052c319f1b46dc1be9e188a91bdc",
    "vsa.api.json": "c4c721bf4e784964caa66fd1817eee0e84ca4177b3cd2f7d4c918af7df59da93",
  };

  test("exactly these files, with exactly these hashes", () => {
    expect(readdirSync(dir2).sort()).toEqual(Object.keys(snapshot));
    for (const [file, sha] of Object.entries(snapshot)) expect([file, sha256File(join(dir2, file))]).toEqual([file, sha]);
  });

  test("same workflows, models and pins as @1; only the audio guide is new", () => {
    expect(tpl2.variants.dense.workflow).toEqual(tpl.variants.dense.workflow);
    expect(tpl2.variants.vsa!.workflow).toEqual(tpl.variants.vsa!.workflow);
    expect({ ...tpl2.manifest, template: "x" }).toEqual({ ...tpl.manifest, template: "x" });
    expect(tpl2.manifest.template).toBe("h3-ref2va@2");
    const { audioGuide, template, ...rest2 } = tpl2.bindings;
    const { template: t1, ...rest1 } = tpl.bindings;
    expect(rest2).toEqual(rest1 as never);
    expect([template, t1]).toEqual(["h3-ref2va@2", "h3-ref2va@1"]);
    expect(tpl.bindings.audioGuide).toBeUndefined();
    expect(audioGuide).toEqual({
      loadNode: "60", guideNode: "61", positive: ["6", 0], latent: ["6", 1], audioVae: ["5", 0],
      consumer: ["11", "conditioning"], frameIdx: 0, requiredClasses: ["LoadAudio", "MiniMaxH3AddGuide"],
    });
    // the guide's audio VAE input is the H3 audio VAE in both variants
    for (const v of [tpl2.variants.dense, tpl2.variants.vsa!]) expect(v.workflow["5"]!.inputs.vae_name).toBe("minimax_h3_audio_vae_fp32.safetensors");
  });
});

// h3-fl2va@1 = the 李律 EP01 / 微辣 EP03 workflow (fl2va pruned int8 + fl2v turbo 8-step LoRA, first frame +
// LoadAudio -> MiniMaxH3AddGuide). Frozen from its first release: any change means h3-fl2va@2.
describe("template h3-fl2va@1 is frozen", () => {
  const dirF = join(TEMPLATES_ROOT, "h3-fl2va@1");
  const snapshot: Record<string, string> = {
    "bindings.json": "259d423d0b334c5b2d9e888fb6e415ee40af2be8572a71b23547e3e6837a2600",
    "fl2va.api.json": "d06bd58138de7a76b2d3cf4ef29b5d37014bd3f835206715dbfa69958f2c0372",
    "manifest.json": "98e57d356a768bcfb5ab7f45a070a5b55e3db8c42ec8bda5628d01473d43e7db",
    "object_info.snapshot.json": "a2e0771c8d6774150a864225c423457c09c611bc3d71ba5ca99f262d6620c8ae",
  };

  test("exactly these files, with exactly these hashes", () => {
    expect(readdirSync(dirF).sort()).toEqual(Object.keys(snapshot));
    for (const [file, sha] of Object.entries(snapshot)) expect([file, sha256File(join(dirF, file))]).toEqual([file, sha]);
  });

  test("the loaded template reports the same file hashes", () => {
    expect(tplF.variants.dense.fileSha256).toBe(snapshot["fl2va.api.json"]!);
    expect(tplF.bindingsSha256).toBe(snapshot["bindings.json"]!);
  });
});
