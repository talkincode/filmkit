// h3-fl2va@1: the 李律 EP01 / 微辣 EP03 lip-sync pipeline as a colab-comfy template (first frame + driving audio,
// fl2va pruned int8 + fl2v turbo 8-step LoRA). Offline: no colab, no network, no money.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectJobs, type PlanJson } from "../src/batch.ts";
import { buildJobsDoc } from "../src/bundle.ts";
import { cachePaths, jobCacheKey, writeFileAtomic, type CacheMeta } from "../src/cache.ts";
import { sha256Hex } from "../src/canonical.ts";
import { main } from "../src/cli.ts";
import { estimateCU, loadEstimates } from "../src/estimate.ts";
import { bindInput, estimateKey, imageSize, jobFrames, resolveInputs, usesAudioGuideSplice, validateJob } from "../src/job.ts";
import { bindWorkflow, conditioningSpec, loadTemplate, TEMPLATE_NAMES, type ResolvedAudio, type ResolvedRef } from "../src/workflow.ts";
import { FL2VA_JOB, fakePng, fakePngSized, fakeWav, makeFl2vaJob, tmpProject, tpl, tplF } from "./support.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const wf = tplF.variants.dense.workflow;

describe("h3-fl2va@1 is the EP01 / EP03 workflow", () => {
  test("one dense variant, no VSA, no refs: first frame + built-in audio guide", () => {
    expect(tplF.variants.vsa).toBeUndefined();
    expect(tplF.bindings.refs).toBeUndefined();
    expect(tplF.bindings.firstFrame).toEqual({ loadNode: "20", target: ["6", "first_frame"] });
    expect(tplF.bindings.audio).toEqual({ loadNode: "21", guideNode: "16" });
    expect(tplF.bindings.estimateKey).toBe("fl2va-8step");
    expect(tplF.manifest.customNodes).toEqual([]);
  });

  test("models, LoRA and sampler settings exactly as in the real runs", () => {
    expect(wf["1"]).toEqual({ class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } });
    expect(wf["2"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", strength_model: 1.0 } });
    expect(wf["3"]!.inputs).toEqual({ clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" });
    expect(wf["4"]!.inputs.vae_name).toBe("minimax_h3_video_vae_fp16.safetensors");
    expect(wf["5"]!.inputs.vae_name).toBe("minimax_h3_audio_vae_fp32.safetensors");
    expect(wf["6"]!.class_type).toBe("MiniMaxH3ImageToVideo");
    expect(wf["6"]!.inputs.first_frame).toEqual(["20", 0]);
    expect(wf["6"]!.inputs.last_frame).toBeUndefined(); // EP01 run2/trial (first == last) was dropped from run3 on
    expect(wf["16"]).toEqual({
      class_type: "MiniMaxH3AddGuide",
      inputs: { positive: ["6", 0], latent: ["6", 1], frame_idx: 0, audio_vae: ["5", 0], audio: ["21", 0] },
    });
    expect(wf["7"]!.inputs).toEqual({ sampler_name: "res_multistep" });
    expect(wf["8"]!.inputs).toEqual({ model: ["2", 0], scheduler: "simple", steps: 8, denoise: 1.0 });
    expect(wf["10"]).toEqual({ class_type: "BasicGuider", inputs: { model: ["2", 0], conditioning: ["16", 0] } }); // cfg 1, no negative
    expect(wf["11"]!.inputs.latent_image).toEqual(["6", 1]);
    expect(wf["14"]!.inputs.fps).toBe(24);
    // shift: no MiniMaxH3SigmaShift node, so the model default (12 video / 3 audio) applies, as in EP01/EP03
    expect(Object.values(wf).some((n) => n.class_type === "MiniMaxH3SigmaShift")).toBe(false);
  });

  test("bindings.fps / length grid come from MiniMaxH3ImageToVideo (5 + 17k at 24 fps)", () => {
    expect(tplF.bindings.fps).toBe(24);
    expect(conditioningSpec(tplF).length).toMatchObject({ min: 5, step: 17 });
    expect(jobFrames(makeFl2vaJob(), tplF)).toBe(107); // 3.86 s -> 93 -> 107, as EP04 s01a
  });
});

describe("every template only uses pinned weights and snapshot/required classes", () => {
  for (const name of TEMPLATE_NAMES) {
    test(`${name}: each model file in the workflow is in the manifest (pinned revision + sha256)`, () => {
      const t = loadTemplate(name);
      const files = new Set(t.manifest.weights.map((w) => w.file.split("/").pop()));
      for (const v of [t.variants.dense, t.variants.vsa]) {
        if (!v) continue;
        for (const n of Object.values(v.workflow)) {
          for (const k of ["unet_name", "lora_name", "clip_name", "vae_name"]) {
            const f = n.inputs[k];
            if (typeof f === "string") expect([k, files.has(f)]).toEqual([k, true]);
          }
        }
        const classes = new Set(Object.values(v.workflow).map((n) => n.class_type));
        for (const c of t.bindings.requiredClasses) if (c !== "Ref2VAVSAGatePatch" || v === t.variants.vsa) expect([c, classes.has(c)]).toEqual([c, true]);
      }
      for (const w of t.manifest.weights) expect(/^[0-9a-f]{64}$/.test(w.sha256) && /^[0-9a-f]{40}$/.test(w.revision) && w.bytes > 0).toBe(true);
    });
  }

  test("h3-fl2va@1 pins: fl2va int8 and the 8-step LoRA at the revisions Ref2VA already uses", () => {
    const by = Object.fromEntries(tplF.manifest.weights.map((w) => [w.file, w]));
    expect(by["diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"]).toMatchObject({
      repo: "Comfy-Org/MiniMax-H3", revision: "e5eb578a89295337b8ff433a035929ce0279e0b6", bytes: 20970379616,
      sha256: "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a",
    });
    expect(by["minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"]).toMatchObject({
      repo: "lightx2v/Minimax-h3-Turbo", revision: "a29e57d195f80ead07c89f89e55ecf2911e893c5", subdir: "loras", bytes: 1956193000,
      sha256: "2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e",
    });
    // text encoder and both VAEs are the very same pins as h3-ref2va
    const shared = tpl.manifest.weights.filter((w) => !/ref2va|vsa_gate|turbo/.test(w.file));
    for (const w of shared) expect(by[w.file]).toEqual(w);
    expect(tplF.manifest.comfyui).toEqual(tpl.manifest.comfyui);
    expect(tplF.manifest.launch).toEqual(tpl.manifest.launch);
  });
});

describe("bindWorkflow (h3-fl2va@1)", () => {
  const image: ResolvedRef = { path: "./kf/s01a.png", sha256: "a".repeat(64), ext: "png" };
  const audio: ResolvedAudio = { path: "./vo/s01a.wav", sha256: "e".repeat(64), ext: "wav", durationSec: 3.56 };
  const job = makeFl2vaJob();

  test("patches only prompt, size, length, seed, the first-frame and audio file names", () => {
    const b = bindWorkflow(tplF, bindInput(job, tplF), 1, { refs: [], image, audio });
    const changed = Object.keys(wf).flatMap((id) =>
      Object.keys({ ...wf[id]!.inputs, ...b.workflow[id]!.inputs }).filter((k) => JSON.stringify(wf[id]!.inputs[k]) !== JSON.stringify(b.workflow[id]!.inputs[k])).map((k) => `${id}.${k}`),
    );
    expect(changed.sort()).toEqual(["20.image", "21.audio", "6.height", "6.length", "6.prompt", "6.width", "9.noise_seed"]);
    expect(Object.keys(b.workflow).sort()).toEqual(Object.keys(wf).sort());
    expect(b.workflow["20"]!.inputs.image).toBe(`${"a".repeat(64)}.png`);
    expect(b.workflow["21"]!.inputs.audio).toBe(`${"e".repeat(64)}.wav`);
    expect([b.workflow["6"]!.inputs.width, b.workflow["6"]!.inputs.height, b.workflow["6"]!.inputs.length]).toEqual([768, 1024, 107]);
    expect(b.workflow["9"]!.inputs.noise_seed).toBe(20261020); // seed + candidate
    expect(b.workflow["15"]!.inputs.filename_prefix).toBe("fk/out");
  });

  test("refuses to bind without audio, without image, or with refs", () => {
    expect(() => bindWorkflow(tplF, bindInput(job, tplF), 0, { refs: [], image })).toThrow(/driving audio/);
    expect(() => bindWorkflow(tplF, bindInput(job, tplF), 0, { refs: [], audio })).toThrow(/first-frame/);
    expect(() => bindWorkflow(tplF, bindInput(job, tplF), 0, { refs: [image], image, audio })).toThrow(/first-frame/);
    expect(() => bindWorkflow(tpl, bindInput(makeFl2vaJob({ template: "h3-ref2va@1" }), tpl), 0, { refs: [image], image })).toThrow(/not a first-frame/);
  });
});

describe("validateJob (h3-fl2va@1)", () => {
  let p: ReturnType<typeof tmpProject>;
  beforeAll(() => {
    p = tmpProject();
    p.write("kf/s01a.png", fakePngSized(960, 1280, "kf")); // 3:4 like EP04 master_final.png
    p.write("kf/wide.png", fakePngSized(1280, 704, "wide"));
    p.write("kf/near.png", fakePngSized(769, 1024, "near")); // 0.13% off: fine
    p.write("kf/nohdr.png", fakePng("x"));
    p.write("vo/s01a.wav", fakeWav(3.56, "vo"));
    p.write("vo/long.wav", fakeWav(4.6, "long"));
    p.write("refs/a.png", fakePng("a"));
  });
  afterAll(() => p.cleanup());
  const check = (over: Record<string, unknown> = {}) => validateJob(makeFl2vaJob(over), { baseDir: p.dir, tpl: tplF });
  const fields = (over: Record<string, unknown>) => check(over).map((d) => d.field);

  test("a good job has no problems (first frame 960x1280 for 768x1024, VO 3.56 s in a 107 f clip)", () => {
    expect(check()).toEqual([]);
    expect(check({ image: "./kf/near.png" })).toEqual([]);
  });
  test("image and audio are required; refs and sparsity are refused", () => {
    expect(fields({ image: undefined })).toEqual(["image"]);
    expect(fields({ audio: undefined })).toEqual(["audio"]);
    expect(fields({ ref: "./refs/a.png" })).toEqual(["ref"]);
    expect(fields({ sparsity: 0.75 })).toEqual(["sparsity"]);
  });
  test("a first frame of another aspect would be stretched: refused with field image", () => {
    const [d] = check({ image: "./kf/wide.png" });
    expect(d).toMatchObject({ field: "image", message: expect.stringContaining("stretch"), hint: expect.stringContaining("768x1024") });
    expect(check({ image: "./kf/wide.png", resolution: "1280x704" })).toEqual([]);
    expect(fields({ image: "./kf/nohdr.png" })).toEqual(["image"]);
    expect(fields({ image: "./kf/missing.png" })).toEqual(["image"]);
  });
  test("audio longer than the clip is refused (the guide would be cropped)", () => {
    expect(check({ audio: "./vo/long.wav" })[0]).toMatchObject({ field: "audio", message: expect.stringContaining("cropped") });
    expect(check({ audio: "./vo/long.wav", duration: 4.6 })).toEqual([]);
  });
  test("h3-ref2va templates refuse image", () => {
    const j = makeFl2vaJob({ template: "h3-ref2va@2", ref: "./refs/a.png", prompt: "x" });
    expect(validateJob(j, { baseDir: p.dir, tpl: loadTemplate("h3-ref2va@2") }).map((d) => d.field)).toEqual(["image"]);
  });

  test("cache key: first-frame and audio bytes are in it, their paths are not", () => {
    const key = (over: Record<string, unknown> = {}) => {
      const j = makeFl2vaJob(over);
      return jobCacheKey(tplF, j, 0, resolveInputs(j, p.dir));
    };
    p.write("kf/copy.png", fakePngSized(960, 1280, "kf"));
    p.write("kf/other.png", fakePngSized(960, 1280, "other"));
    p.write("vo/copy.wav", fakeWav(3.56, "vo"));
    p.write("vo/retake.wav", fakeWav(3.56, "retake"));
    const base = key();
    expect(key({ image: "./kf/copy.png" })).toBe(base);
    expect(key({ audio: "./vo/copy.wav" })).toBe(base);
    expect(key({ image: "./kf/other.png" })).not.toBe(base);
    expect(key({ audio: "./vo/retake.wav" })).not.toBe(base);
    expect(key({ seed: 1 })).not.toBe(base);
  });
});

describe("imageSize (header only)", () => {
  test("PNG IHDR, JPEG SOF0 after APP0, WebP VP8X / VP8L / VP8", () => {
    expect(imageSize(fakePngSized(960, 1280))).toEqual({ width: 960, height: 1280 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x03, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 768, height: 1024 });
    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0); vp8x.write("WEBP", 8); vp8x.write("VP8X", 12);
    vp8x.writeUIntLE(767, 24, 3); vp8x.writeUIntLE(1023, 27, 3);
    expect(imageSize(vp8x)).toEqual({ width: 768, height: 1024 });
    const vp8l = Buffer.alloc(30);
    vp8l.write("RIFF", 0); vp8l.write("WEBP", 8); vp8l.write("VP8L", 12);
    vp8l.writeUInt32LE((767 & 0x3fff) | ((1023 & 0x3fff) << 14), 21);
    expect(imageSize(vp8l)).toEqual({ width: 768, height: 1024 });
    const vp8 = Buffer.alloc(30);
    vp8.write("RIFF", 0); vp8.write("WEBP", 8); vp8.write("VP8 ", 12);
    vp8.writeUInt16LE(768, 26); vp8.writeUInt16LE(1024, 28);
    expect(imageSize(vp8)).toEqual({ width: 768, height: 1024 });
    expect(imageSize(fakePng("short"))).toBeUndefined();
    expect(imageSize(Buffer.from("not an image at all, really"))).toBeUndefined();
  });
});

describe("estimate (h3-fl2va@1)", () => {
  const cfg = loadEstimates();
  const ref = 1344 * 768 * 124;
  const job = (frames: number, w = 704, h = 1280) => ({ node: `n${frames}`, candidate: 0, variant: "fl2va-8step", width: w, height: h, frames });

  test("its own warm key; the built-in guide is NOT multiplied again", () => {
    const j = makeFl2vaJob();
    expect(estimateKey(j, tplF)).toBe("fl2va-8step");
    expect(usesAudioGuideSplice(j, tplF)).toBe(false);
  });

  test("L4 reproduces the measured EP03 / EP01 warm clips within -6% .. +12%", () => {
    // submit-to-done on L4, 704x1280, poll 5 s (weila-ep03/h3/job/gen.log, lilv-ep01/trial3/gen.log)
    const measured: [number, number][] = [[90, 380.3], [124, 535.2], [141, 620.2], [141, 625.2], [158, 720.2], [90, 380.1]];
    for (const [frames, sec] of measured) {
      const e = estimateCU([job(frames)], cfg, { gpu: "L4" }).jobs[0]!;
      expect(e.calibrated).toBe(true);
      expect(e.genSec / sec - 1).toBeGreaterThan(-0.06);
      expect(e.genSec / sec - 1).toBeLessThan(0.12);
    }
  });

  test("A100 is derived from the Ref2VA A100/L4 ratio and flagged uncalibrated", () => {
    const e = estimateCU([job(107, 768, 1024)], cfg, { gpu: "A100" }).jobs[0]!;
    expect(e.calibrated).toBe(false);
    expect(e.basis).toContain("never measured");
    expect(cfg.gpus.A100!.warmSecAtRef["fl2va-8step"]).toBe(Math.round(540 * (61 / 316)));
    expect(e.genSec).toBeCloseTo(10 + 104 * ((768 * 1024 * 107) / ref), 1);
    // and it costs more per clip than Ref2VA 4-step dense on the same GPU and shape
    const r2 = estimateCU([{ ...job(107, 768, 1024), variant: "dense" }], cfg, { gpu: "A100" }).jobs[0]!;
    expect(r2.calibrated).toBe(true);
    expect(e.genSec).toBeGreaterThan(r2.genSec);
  });
});

describe("batch / bundle / record (h3-fl2va@1)", () => {
  let p: ReturnType<typeof tmpProject>;
  const KF = fakePngSized(960, 1280, "kf");
  const VO = fakeWav(3.56, "vo");
  beforeAll(() => {
    p = tmpProject();
    p.write("kf/s01a.png", KF);
    p.write("vo/s01a.wav", VO);
  });
  afterAll(() => p.cleanup());
  const P = { ...FL2VA_JOB } as Record<string, unknown>;
  delete P.node;
  const plan = (params: Record<string, unknown>[]): PlanJson => ({
    film: "f",
    nodes: params.map((pp, i) => ({ id: `s${i}`, status: "missing", profile: { name: "colab-comfy" }, task: "h3-fl2va", params: pp, inputs: {} })),
  });

  test("jobs.json bundles first frame + WAV, requires the fl2va classes, validates against the schema", () => {
    const { selected } = collectJobs(plan([P]), p.dir);
    expect(selected[0]!.variant).toBe("dense");
    const { doc, inputs } = buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: p.dir, limits: { hardDeadlineEpoch: 1792345678 } });
    const files = [`${sha(KF)}.png`, `${sha(VO)}.wav`];
    expect(doc.jobs[0]!.inputs.map((i) => i.file)).toEqual(files);
    expect([...inputs.keys()].sort()).toEqual([...files].sort());
    expect(doc.jobs[0]!.workflow["20"]!.inputs.image).toBe(files[0]);
    expect(doc.jobs[0]!.workflow["21"]!.inputs.audio).toBe(files[1]);
    expect(doc.requiredClasses).toEqual(["MiniMaxH3ImageToVideo", "MiniMaxH3AddGuide", "LoadAudio", "SaveVideo"]);
    expect(doc.manifest.customNodes).toEqual([]);
    const schema = JSON.parse(readFileSync(join(REPO, "tools/colab-comfy/schema/jobs.schema.json"), "utf8"));
    const v = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(v(JSON.parse(JSON.stringify(doc))), JSON.stringify(v.errors)).toBe(true);
  });

  test("one session, one template: mixing h3-fl2va@1 with h3-ref2va is refused", () => {
    p.write("refs/a.png", fakePng("a"));
    const { selected } = collectJobs(plan([P, { template: "h3-ref2va@2", prompt: "x", ref: "./refs/a.png", seed: 1, duration: 3, resolution: "768x1024" }]), p.dir);
    expect(() => buildJobsDoc({ session: "fk-t", nodes: selected, baseDir: p.dir })).toThrow(/one session runs one template/);
  });

  test("validate CLI: --image/--audio summary; materialize writes a schema-valid record with params.image", async () => {
    const flags = Object.entries({ ...FL2VA_JOB }).map(([k, v]) => `--${k}=${v}`);
    const io = ["--out=./build/s01a.mp4", "--record=./build/s01a.colab.json"];
    const r = await main(["validate", ...flags, ...io], {}, p.dir);
    expect([r.exitCode, r.stdout.trim()]).toEqual([0, "ok: s01a dense 768x1024 107f, first frame, audio guide, 1 candidate(s)"]);
    const bad = await main(["validate", ...flags.filter((f) => !f.startsWith("--audio=")), ...io, "--json"], {}, p.dir);
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stderr).errors[0]).toMatchObject({ field: "audio" });

    const job = makeFl2vaJob();
    const key = jobCacheKey(tplF, job, 0, resolveInputs(job, p.dir));
    const clip = Buffer.from("clip bytes");
    const paths = cachePaths(p.dir, key);
    writeFileAtomic(paths.clip, clip);
    const meta: CacheMeta = {
      key, node: "s01a", candidate: 0, seed: job.seed, session: "fk-unit", downloadedAt: "2026-01-01T00:00:00.000Z",
      job: { key, state: "done", wallSec: 78, peakVramMiB: 40000 },
      video: { sha256: sha256Hex(clip), bytes: clip.length },
    } as unknown as CacheMeta;
    writeFileAtomic(paths.meta, JSON.stringify(meta));
    const m = await main(["materialize", ...flags, ...io], {}, p.dir);
    expect(m.exitCode, m.stderr).toBe(0);
    const rec = JSON.parse(readFileSync(join(p.dir, "build/s01a.colab.json"), "utf8"));
    const schema = JSON.parse(readFileSync(join(REPO, "tools/colab-comfy/schema/run-record.schema.json"), "utf8"));
    const v = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(v(rec), JSON.stringify(v.errors)).toBe(true);
    expect(rec.template).toMatchObject({ name: "h3-fl2va@1", variant: "dense" });
    expect(rec.params.refs).toEqual([]);
    expect(rec.params.image).toEqual({ path: "./kf/s01a.png", sha256: sha(KF) });
    expect(rec.params.audio).toMatchObject({ path: "./vo/s01a.wav", sha256: sha(VO), durationSec: 3.56 });
  });
});
