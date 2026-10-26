// Offline conversion: a vflow bundle in, a legal filmkit.yaml out. Fixtures are
// real exports from vflow's own acceptance server (see test/fixtures), so the
// reader is pinned to what vflow actually emits, not to what this repo imagines.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseBundle } from "../src/bundle.ts";
import { convertBundle } from "../src/convert.ts";
import { PullError } from "../src/errors.ts";
import { project } from "../../../tests/helpers.ts";

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const demo = () => fixture("vflow-v1-demo.bundle.json");
const reference = () => fixture("vflow-v2-reference.bundle.json");
const convert = (raw: unknown) => convertBundle(parseBundle(raw), "test");
const film = (raw: unknown) => YAML.parse(convert(raw).yaml) as Record<string, any>;

function failure(fn: () => unknown): PullError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PullError) return err;
    throw err;
  }
  throw new Error("expected a PullError");
}

describe("convert: what is taken", () => {
  test("shot description, video prompt, duration and sequence order become scenes", () => {
    const f = film(demo());
    expect(f.scenes.map((s: any) => s.id)).toEqual(["shot-001", "shot-002", "shot-003"]);
    const s1 = f.scenes[0];
    expect(s1.intent.description).toBe("镜头 1 雨巷");
    expect(s1.intent.action).toBe("运镜提示词 1");
    expect(s1.duration).toBe(3); // 90 frames at 30 fps
    expect(s1.durationPolicy).toBe("min");
    expect(s1.impl).toEqual({ profile: "filmkit/static", task: "clip" }); // never guesses a tool
    expect(s1.produces).toEqual({ video: "./assets/shot-001.mp4" });
    expect(f.output.video).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  test("shot materials and the pinned subject's reference pack become assets referenced by the scene, deduplicated", () => {
    const f = film(demo());
    // preview-png is shot-001's reference, its candidate and the subject's approved reference: one asset.
    expect(f.assets).toEqual({
      "ref-preview-png": { uri: "./assets/vflow/cdd5305162d50a27.png", kind: "image" },
    });
    expect(f.scenes[0].intent.references).toEqual(["ref-preview-png"]);
    expect(f.scenes[1].intent.references).toBeUndefined(); // a shot without materials stays plain
  });

  test("subject definition and per-shot provenance are kept as annotations, not as fields", () => {
    const a = film(demo()).metadata.annotations;
    expect(a["vflow.source"]).toEqual({ protocol: "vflow/v1", project: "demo", composition: "episode-001", revision: 1 });
    expect(a["vflow.subjects"]["character-main@1"]).toMatchObject({ name: "信使", kind: "character", invariants: ["黄色雨衣"], variants: { raincoat: "雨衣造型" } });
    expect(a["vflow.shots"]["shot-001"].shot).toBe("shot-001");
    expect(a["vflow.shots"]["shot-001"].prompts).toEqual({ image: "画面提示词 1" }); // prompts.image has no field: kept here
    expect(a["vflow.shots"]["shot-001"].subjects[0]).toMatchObject({ subject: "character-main@1", variant: "raincoat" });
  });

  test("v2 bundles are read for subjects only; pinned authoring materials are reported, not imported", () => {
    const c = convert(reference());
    const f = YAML.parse(c.yaml);
    const spell = f.scenes.find((s: any) => s.id === "spell");
    // suwei + boat default variants: 2 approved views each
    expect(spell.intent.references).toHaveLength(4);
    expect(c.warnings.join("\n")).toMatch(/5 pinned authoring material\(s\) are not imported/);
    expect(f.metadata.annotations["vflow.source"].protocol).toBe("vflow/v2");
  });

  test("what is not imported is listed, never silently dropped", () => {
    const c = convert(demo());
    expect(c.ignored).toContain("audioTracks: 1");
  });

  test("the fetch plan lists exactly the files the film references, with their pins", () => {
    const c = convert(demo());
    expect(c.fetch).toEqual([
      { assetId: "preview-png", sha256: "cdd5305162d50a27fa38bf6314e221207fac460f7004a358b122aaae651f0a0d", mimeType: "image/png", sizeBytes: 7549, targets: ["./assets/vflow/cdd5305162d50a27.png"] },
    ]); // the bgm wav is in the manifest but not needed, so it is not fetched
  });
});

describe("convert: selected clips, estimates and naming", () => {
  test("a selected video becomes the scene's ready clip and is fetched to that path", () => {
    const b = demo();
    b.dependencies.assets.push({ id: "clip-1", sha256: "a".repeat(64), mimeType: "video/webm", sizeBytes: 10 });
    b.composition.shots["shot-002"].selected.video = "clip-1";
    const c = convert(b);
    expect(YAML.parse(c.yaml).scenes[1].produces).toEqual({ video: "./assets/shot-002.webm" });
    expect(c.fetch.find((i) => i.assetId === "clip-1")?.targets).toEqual(["./assets/shot-002.webm"]);
  });

  test("a selected 'video' that is not a video stays a placeholder with a warning", () => {
    const b = demo();
    b.composition.shots["shot-002"].selected.video = "preview-png";
    const c = convert(b);
    expect(YAML.parse(c.yaml).scenes[1].produces.video).toBe("./assets/shot-002.mp4");
    expect(c.warnings.join("\n")).toMatch(/shot-002\.selected\.video is image\/png/);
  });

  test("a shot without durationFrames is estimated and flagged", () => {
    const b = demo();
    delete b.composition.shots["shot-002"].durationFrames;
    const c = convert(b);
    expect(YAML.parse(c.yaml).scenes[1].duration).toBe(3);
    expect(c.warnings.join("\n")).toMatch(/1 shot\(s\) have no durationFrames .*shot-002/);
  });

  test("durations are frames / fps, exactly", () => {
    const b = demo();
    b.composition.format.fps = 24;
    b.composition.shots["shot-001"].durationFrames = 10;
    expect(YAML.parse(convert(b).yaml).scenes[0].duration).toBe(0.416667);
  });

  test("ids that filmkit cannot take are slugged; clashes get a suffix; non-latin ids fall back to shot-NN", () => {
    const b = demo();
    const shots = b.composition.shots;
    shots["Shot_A"] = shots["shot-001"];
    shots["shot-a"] = shots["shot-002"];
    shots["镜头一"] = shots["shot-003"];
    b.composition.sequence = ["Shot_A", "shot-a", "镜头一"];
    const f = film(b);
    expect(f.scenes.map((s: any) => s.id)).toEqual(["shot-a", "shot-a-2", "shot-03"]);
    expect(f.metadata.annotations["vflow.shots"]["shot-a"].shot).toBe("Shot_A"); // the original id survives
  });

  test("candidate reference-pack entries are skipped with a warning", () => {
    const b = demo();
    b.dependencies.subjects[0].variants.raincoat.referencePack.push({ asset: "preview-wav", status: "candidate" });
    const c = convert(b);
    expect(c.warnings.join("\n")).toMatch(/character-main@1: candidate reference-pack entries were skipped/);
    expect(Object.keys(YAML.parse(c.yaml).assets)).toEqual(["ref-preview-png"]);
  });
});

describe("convert: boundaries fail explicitly", () => {
  test("unknown apiVersion is refused with its field", () => {
    const b = demo();
    b.apiVersion = "vflow/v9";
    const e = failure(() => convert(b));
    expect(e.exitCode).toBe(2);
    expect(e.details[0]).toMatchObject({ code: "invalid-input", field: "apiVersion" });
  });

  test("the pre-rename wire id is accepted and kept verbatim as provenance", () => {
    const b = demo();
    b.apiVersion = "video-compose/v1";
    expect(film(b).metadata.annotations["vflow.source"].protocol).toBe("video-compose/v1");
  });

  test("the REST/MCP wrapper and YAML text are both accepted", () => {
    const wrapped = { bundle: demo(), serialized: "ignored" };
    expect(convert(wrapped).scenes).toBe(3);
    expect(convertBundle(parseBundle(YAML.stringify(demo())), "test").scenes).toBe(3);
  });

  test("an asset missing from the manifest names the field", () => {
    const b = demo();
    b.dependencies.assets = b.dependencies.assets.filter((a: any) => a.id !== "preview-png");
    const e = failure(() => convert(b));
    expect(e.details[0]!.field).toBe("composition.shots.shot-001.references.images[0].asset");
  });

  test("a pinned subject that is not in the bundle, or has no resolvable variant, is refused", () => {
    const b = demo();
    b.dependencies.subjects = [];
    expect(failure(() => convert(b)).details[0]!.field).toBe("composition.shots.shot-001.subjects[0]");
    const c = demo();
    c.composition.shots["shot-001"].subjects[0].variant = "nope";
    expect(failure(() => convert(c)).details[0]!.message).toMatch(/no variant "nope"/);
  });

  test("malformed fields are all reported, with paths", () => {
    const b = demo();
    b.composition.format.fps = 29.97;
    b.composition.shots["shot-001"].durationFrames = -1;
    const fields = failure(() => convert(b)).details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["composition.format.fps", "composition.shots.shot-001.durationFrames"]));
  });

  test("a sequence entry without a shot is refused", () => {
    const b = demo();
    b.composition.sequence.push("ghost");
    expect(failure(() => convert(b)).details[0]!.field).toBe("composition.sequence[3]");
  });
});

describe("convert: determinism and legality", () => {
  test("the same bundle gives byte-identical output", () => {
    expect(convert(demo()).yaml).toBe(convert(demo()).yaml);
    expect(convert(reference()).yaml).toBe(convert(reference()).yaml);
  });

  test("the result is a film filmkit accepts, and plan lists the missing pictures as work", () => {
    const p = project();
    try {
      p.write("filmkit.yaml", convert(demo()).yaml);
      const plan = p.json<{ nodes: { id: string; status: string; executor: string }[]; missingFiles?: unknown[] }>("plan");
      expect(plan.exitCode).toBe(0);
      expect(plan.out!.nodes.map((n) => n.id)).toEqual(["shot-001", "shot-002", "shot-003"]);
      expect(plan.out!.nodes.every((n) => n.status === "missing" && n.executor === "place files")).toBe(true);
      expect(JSON.stringify(plan.out)).toContain("./assets/vflow/cdd5305162d50a27.png");
    } finally {
      p.cleanup();
    }
  });
});
