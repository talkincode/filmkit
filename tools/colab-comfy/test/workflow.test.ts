import { describe, expect, test } from "bun:test";
import { bindInput } from "../src/job.ts";
import { bindWorkflow, loadTemplate, type ResolvedAudio, type ResolvedRef, type WorkflowJson } from "../src/workflow.ts";
import { ColabComfyError } from "../src/errors.ts";
import { makeJob, tpl, tpl2 } from "./support.ts";

/** Every leaf path where `b` differs from `a` (added, removed or changed), sorted. */
function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== "object") {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k)).sort();
}

const ref = (tag: string, ext: ResolvedRef["ext"] = "png"): ResolvedRef => ({ path: `./refs/${tag}.${ext}`, sha256: tag.repeat(64).slice(0, 64), ext });

function bind(over: Record<string, unknown>, refs: ResolvedRef[], candidate = 0, audio?: ResolvedAudio, template = tpl) {
  const job = makeJob(over);
  return bindWorkflow(template, bindInput(job, template), candidate, audio ? { refs, audio } : { refs });
}

const vo: ResolvedAudio = { path: "./vo/s1a.wav", sha256: "e".repeat(64), ext: "wav", durationSec: 3.56 };

describe("bindWorkflow differs from the template only at bound paths", () => {
  test("dense, 1 ref", () => {
    const b = bind({ sparsity: 0 }, [ref("a")]);
    expect(b.variant).toBe("dense");
    expect(diffPaths(tpl.variants.dense.workflow, b.workflow)).toEqual([
      "50.inputs.image",
      "6.inputs.height",
      "6.inputs.length",
      "6.inputs.prompt",
      "6.inputs.width",
      "8.inputs.noise_seed",
    ]);
    expect(b.workflow["6"]!.inputs.length).toBe(107);
    expect(b.workflow["8"]!.inputs.noise_seed).toBe(20261017);
    expect(b.workflow["50"]!.inputs.image).toBe(`${ref("a").sha256}.png`);
    expect(b.workflow["144"]).toBeUndefined();
  });

  test("vsa 0.5, 1 ref: also patches 144.sparsity, nothing else", () => {
    const b = bind({ sparsity: 0.5 }, [ref("a")]);
    expect(b.variant).toBe("vsa");
    expect(diffPaths(tpl.variants.vsa.workflow, b.workflow)).toEqual([
      "144.inputs.sparsity",
      "50.inputs.image",
      "6.inputs.height",
      "6.inputs.length",
      "6.inputs.prompt",
      "6.inputs.width",
      "8.inputs.noise_seed",
    ]);
    expect(b.workflow["144"]!.inputs.sparsity).toBe(0.5);
    expect(b.workflow["142"]!.inputs.model).toEqual(["144", 0]); // gate stays wired in
  });

  test("ref2/ref3 add exactly nodes 51/52 and ref_image_1/2 on node 6", () => {
    const b = bind({ ref2: "./refs/b.png", ref3: "./refs/c.png" }, [ref("a"), ref("b", "jpg"), ref("c", "webp")]);
    const one = bind({}, [ref("a")]);
    expect(diffPaths(one.workflow, b.workflow)).toEqual(["51", "52", "6.inputs.ref_images.ref_image_1", "6.inputs.ref_images.ref_image_2"]);
    expect(b.workflow["6"]!.inputs["ref_images.ref_image_0"]).toEqual(["50", 0]);
    expect(b.workflow["6"]!.inputs["ref_images.ref_image_1"]).toEqual(["51", 0]);
    expect(b.workflow["6"]!.inputs["ref_images.ref_image_2"]).toEqual(["52", 0]);
    expect(b.workflow["51"]).toEqual({ class_type: "LoadImage", inputs: { image: `${ref("b").sha256}.jpg` } });
    expect(b.workflow["52"]!.inputs.image).toBe(`${ref("c").sha256}.webp`);
  });

  test("candidate i uses seed + i and nothing else changes", () => {
    const c0 = bind({}, [ref("a")], 0);
    const c2 = bind({}, [ref("a")], 2);
    expect(diffPaths(c0.workflow, c2.workflow)).toEqual(["8.inputs.noise_seed"]);
    expect(c2.workflow["8"]!.inputs.noise_seed).toBe(20261019);
  });

  test("the template object itself is never mutated", () => {
    const before = JSON.stringify(tpl.variants.vsa.workflow);
    bind({ sparsity: 0.75, ref2: "./refs/b.png" }, [ref("a"), ref("b")]);
    expect(JSON.stringify(tpl.variants.vsa.workflow)).toBe(before);
  });

  // Wiring as in lilv-ep01 run2..run4 (fl2va): LoadAudio -> MiniMaxH3AddGuide(positive=6.0, latent=6.1,
  // frame_idx 0, audio_vae=5.0) -> BasicGuider.conditioning; the sampler keeps latent_image = 6.1.
  for (const sparsity of [0, 0.75]) {
    test(`audio guide (sparsity ${sparsity}): adds exactly nodes 60/61 and rewires 11.conditioning`, () => {
      const plain = bind({ sparsity }, [ref("a")], 0, undefined, tpl2);
      const guided = bind({ sparsity }, [ref("a")], 0, vo, tpl2);
      expect(diffPaths(plain.workflow, guided.workflow)).toEqual(["11.inputs.conditioning.0", "60", "61"]);
      expect(guided.workflow["60"]).toEqual({ class_type: "LoadAudio", inputs: { audio: `${"e".repeat(64)}.wav` } });
      expect(guided.workflow["61"]).toEqual({
        class_type: "MiniMaxH3AddGuide",
        inputs: { positive: ["6", 0], latent: ["6", 1], frame_idx: 0, audio_vae: ["5", 0], audio: ["60", 0] },
      });
      expect(guided.workflow["11"]!.inputs.conditioning).toEqual(["61", 0]);
      expect(guided.workflow["12"]!.inputs.latent_image).toEqual(["6", 1]);
      expect(guided.workflow["5"]!.class_type).toBe("VAELoader"); // the audio VAE the guide encodes with
    });
  }

  test("@2 without audio binds exactly like @1; @1 cannot bind audio", () => {
    for (const sparsity of [0, 0.75]) {
      expect(bind({ sparsity }, [ref("a")], 0, undefined, tpl2).workflow).toEqual(bind({ sparsity }, [ref("a")]).workflow);
    }
    expect(() => bind({}, [ref("a")], 0, vo)).toThrow(/no audioGuide/);
  });

  test("without audio the workflow has no guide nodes (identical to the template apart from bound fields)", () => {
    const b = bind({}, [ref("a")], 0, undefined, tpl2);
    expect(b.workflow["60"]).toBeUndefined();
    expect(b.workflow["61"]).toBeUndefined();
    expect(b.workflow["11"]!.inputs.conditioning).toEqual(["6", 0]);
  });

  test("output prefix is the constant key prefix", () => {
    expect((bind({}, [ref("a")]).workflow as WorkflowJson)["16"]!.inputs.filename_prefix).toBe("fk/out");
  });
});

describe("loadTemplate", () => {
  test("loads h3-ref2va@1 with the pinned manifest", () => {
    expect(tpl.manifest.comfyui.commit).toBe("ce1e922d8623bb507180e32a0c01a7d0e29edef7");
    expect(tpl.manifest.customNodes[0]!.commit).toBe("323a0a5f7c636cc70f95464145732f81f04a72e9");
    expect(tpl.manifest.weights.map((w) => w.subdir)).toEqual(["diffusion_models", "text_encoders", "vae", "vae", "loras", "loras"]);
    expect(tpl.manifest.weights.every((w) => /^[0-9a-f]{64}$/.test(w.sha256) && /^[0-9a-f]{40}$/.test(w.revision) && w.bytes > 0)).toBe(true);
    expect(tpl.manifest.launch).toEqual(["--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--preview-method", "none", "--disable-pinned-memory"]);
    expect([tpl.manifest.diskFreeGB, tpl.manifest.verifySha256]).toEqual([60, false]);
  });

  test("rejects unknown templates and path-like names with exit 2", () => {
    for (const name of ["h3-ref2va@9", "../x@1", "h3-ref2va", "h3-ref2va@1/../..", ""]) {
      try {
        loadTemplate(name);
        throw new Error(`expected rejection of ${name}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ColabComfyError);
        expect((err as ColabComfyError).exitCode).toBe(2);
      }
    }
  });
});
