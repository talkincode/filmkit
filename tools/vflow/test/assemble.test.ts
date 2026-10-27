import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { main } from "../src/cli.ts";
import { parseBundle } from "../src/bundle.ts";
import { convertBundle } from "../src/convert.ts";
import { media, project, probe, breakFfmpeg } from "../../../tests/helpers.ts";
import { startStub, sha256, TOKEN } from "./stub-vflow.ts";

function fixture() {
  const p = project();
  media.mp4(p.path("source.mp4"), 3, { audio: true });
  media.wav(p.path("voice.wav"), 2, 880);
  media.wav(p.path("music.wav"), 3, 220);
  const bytes = { video: readFileSync(p.path("source.mp4")), voice: readFileSync(p.path("voice.wav")), music: readFileSync(p.path("music.wav")) };
  const bundle = {
    apiVersion: "vflow/v1", revision: 7,
    composition: {
      apiVersion: "vflow/v1", id: "cut", project: "demo", format: { width: 320, height: 180, fps: 24 },
      sequence: ["shot-1"],
      shots: { "shot-1": { description: "Exact cut", durationFrames: 24, dependsOn: [], subjects: [], prompts: {}, references: { images: [], videos: [] }, candidates: { images: [], videos: [], audios: [] }, selected: { video: "video", audio: "voice" } } },
      audioTracks: [{ id: "music", role: "bgm", asset: "music", startFrame: 6, durationFrames: 12, trimStartFrame: 24 }],
    },
    dependencies: { subjects: [], assets: Object.entries(bytes).map(([id, value]) => ({ id, sha256: sha256(value), sizeBytes: value.length, mimeType: id === "video" ? "video/mp4" : "audio/wav" })) },
  };
  return { p, bytes, bundle };
}
async function withCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const old = [process.env.CF_ACCESS_CLIENT_ID, process.env.CF_ACCESS_CLIENT_SECRET];
  process.env.CF_ACCESS_CLIENT_ID = TOKEN.id;
  process.env.CF_ACCESS_CLIENT_SECRET = TOKEN.secret;
  try { return await fn(); }
  finally {
    for (const [i, key] of ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].entries()) {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    }
  }
}

describe("assemble: exact selected outputs and global audio", () => {
  test("real pull -> planned crop -> failure/recovery -> build preserves duration, source trim and track placement", async () => {
    const { p: source, bytes, bundle } = fixture();
    const target = project();
    const stub = await startStub({ bundle, assets: bytes, project: "demo", composition: "cut" });
    try {
      const args = ["pull", "--base", stub.url, "--project", "demo", "--composition", "cut", "--revision", "7", "--mode", "assemble", "--out", target.path("filmkit.yaml"), "--json"];
      const result = await withCredentials(() => main(args));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).downloaded).toBe(3);
      const text = readFileSync(target.path("filmkit.yaml"), "utf8");
      const film = YAML.parse(text);
      expect(film.scenes[0]).toMatchObject({ duration: 1, durationPolicy: "exact", audioMode: "replace" });
      expect(film.timeline.tracks[0]).toMatchObject({ from: 0.25, to: 0.75, fit: "trim", volume: 1 });
      const plan = target.json<any>("plan");
      expect(plan.exitCode).toBe(0);
      expect(plan.out.timeline.total).toBe(1); // source video is 3s, voice 2s
      expect(plan.out.nodes).toHaveLength(1);
      const node = plan.out.nodes[0];
      expect(node.executor).toBe("filmkit run");
      expect(node.params.args).toContain("atrim=start=1,asetpts=PTS-STARTPTS,apad,atrim=duration=0.5");
      expect(existsSync(target.path(node.produces.audio))).toBe(false); // pull never runs ffmpeg
      target.cli("status");
      const lock = readFileSync(target.path("filmkit.lock.yaml"), "utf8");
      const restore = breakFfmpeg();
      try { expect(target.cli("run", node.id).exitCode).toBe(4); } finally { restore(); }
      expect(existsSync(target.path(node.produces.audio))).toBe(false);
      expect(readFileSync(target.path("filmkit.lock.yaml"), "utf8")).toBe(lock);
      expect(target.cli("run", node.id).exitCode).toBe(0);
      const clip = target.path(node.produces.audio);
      expect(probe(clip).duration).toBeCloseTo(0.5, 3);
      const pcm = (input: string, filter?: string) => spawnSync("ffmpeg", ["-v", "error", "-i", input, ...(filter ? ["-af", filter] : []), "-ar", "48000", "-ac", "2", "-f", "s16le", "-"], { maxBuffer: 2 ** 20 });
      const expected = pcm(source.path("music.wav"), node.params.args[4]);
      const actual = pcm(clip);
      expect(expected.status).toBe(0);
      expect(actual.status).toBe(0);
      expect(actual.stdout.equals(expected.stdout)).toBe(true);
      const built = target.json<any>("build");
      expect(built.exitCode).toBe(0);
      expect(probe(target.path(built.out.output)).duration).toBeCloseTo(1, 1);
      const graph = readFileSync(target.path("build/compose.filtergraph.txt"), "utf8");
      expect(graph).toContain("adelay=250:all=1");
      expect(graph).not.toContain("-stream_loop");
      expect(readFileSync(target.path("filmkit.yaml"), "utf8")).toBe(text);
      const again = await withCredentials(() => main([...args, "--force"]));
      expect(again.exitCode).toBe(0);
      expect(JSON.parse(again.stdout).downloaded).toBe(0);
      expect(readFileSync(target.path("filmkit.yaml"), "utf8")).toBe(text);
    } finally { stub.stop(); target.cleanup(); source.cleanup(); }
  });

  test("missing selection, malformed audio and overrun fail before writes; production remains compatible", async () => {
    const { p, bundle } = fixture();
    const target = project();
    try {
      const production = convertBundle(parseBundle(bundle), "fixture");
      expect(YAML.parse(production.yaml).scenes[0].durationPolicy).toBe("min");
      expect(production.ignored).toContain("selected.audio: 1");
      const mutations = [
        (b: any) => { b.composition.shots["shot-1"].selected.video = null; },
        (b: any) => { delete b.composition.shots["shot-1"].durationFrames; },
        (b: any) => { b.composition.shots["shot-1"].selected.audio = "video"; },
        (b: any) => { b.composition.audioTracks[0].durationFrames = 50; },
        (b: any) => { b.composition.audioTracks[0].trimStartFrame = -1; },
        (b: any) => { b.composition.audioTracks = {}; },
        (b: any) => { delete b.revision; },
      ];
      for (const mutate of mutations) {
        const broken = structuredClone(bundle); mutate(broken);
        p.write("bundle.json", JSON.stringify(broken));
        const result = await main(["convert", p.path("bundle.json"), "--mode", "assemble", "--out", target.path("filmkit.yaml"), "--json"]);
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stderr).errors[0].field).toBeDefined();
        expect(readdirSync(target.dir)).toEqual([]);
      }
      p.write("bundle.json", JSON.stringify(bundle));
      expect((await main(["convert", p.path("bundle.json"), "--mode", "assemble", "--out", target.path("filmkit.yaml")])).exitCode).toBe(0);
      expect((await main(["convert", p.path("bundle.json"), "--mode", "invalid", "--out", target.path("filmkit.yaml")])).exitCode).toBe(2);
    } finally { target.cleanup(); p.cleanup(); }
  });

  test("convert/fetch same mode downloads audio too; failed download preserves existing film and lock", async () => {
    const { p: source, bytes, bundle } = fixture();
    const p = project();
    const stub = await startStub({ bundle, assets: bytes, project: "demo", composition: "cut" });
    try {
      source.write("bundle.json", JSON.stringify(bundle));
      expect((await main(["convert", source.path("bundle.json"), "--mode", "assemble", "--out", p.path("filmkit.yaml")])).exitCode).toBe(0);
      const before = readFileSync(p.path("filmkit.yaml"), "utf8");
      p.write("filmkit.lock.yaml", "existing lock sentinel");
      const args = ["fetch", source.path("bundle.json"), "--base", stub.url, "--mode", "assemble", "--dir", p.dir, "--json"];
      stub.behavior.corrupt = "music";
      expect((await withCredentials(() => main(args))).exitCode).toBe(4);
      expect(readdirSync(p.dir).sort()).toEqual(["filmkit.lock.yaml", "filmkit.yaml"]);
      expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe(before);
      expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe("existing lock sentinel");
      stub.behavior.corrupt = undefined;
      expect((await withCredentials(() => main(args))).exitCode).toBe(0);
      expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe(before);
    } finally { stub.stop(); p.cleanup(); source.cleanup(); }
  });
});
