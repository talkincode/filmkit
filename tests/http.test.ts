// `runtime.type: http` (spec §3.5): filmkit calls a generation API itself.
//
// The tests run a real HTTP server on localhost and drive filmkit through it —
// the same code path as a live provider, minus the provider. Both shapes are
// covered: an async task (create → poll → download) like Ark's Seedance, and a
// synchronous response with inline base64 bytes like Gemini's Interactions API.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { film, media, project, type Project } from "./helpers.ts";

let server: Subprocess;
let base: string;

beforeAll(async () => {
  // Out of process: `filmkit run` blocks on a worker subprocess for http tasks,
  // and a blocked parent cannot answer requests from its own event loop.
  server = spawn(["bun", new URL("./stub-api-server.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "inherit" });
  const out = server.stdout;
  if (typeof out === "number" || out === undefined) throw new Error("stub api stdout is not piped");
  const reader = out.getReader();
  const { value } = await reader.read();
  const line = new TextDecoder().decode(value);
  const match = /http:\/\/([^\s]+)/.exec(line);
  if (!match) throw new Error(`stub api did not report a URL: ${line}`);
  base = `http://${match[1]}`;
});

afterAll(() => {
  server.kill();
});

let p: Project;
beforeEach(() => {
  p = project();

  process.env.ARK_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  // Point every URL at the stub (create *and* poll — the poll URL carries the id
  // suffix), and poll fast so the tests stay quick.
  const withStub = (file: string) =>
    readFileSync(new URL(`../profiles/${file}`, import.meta.url), "utf8")
      .replaceAll("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", `${base}/tasks`)
      .replaceAll("https://generativelanguage.googleapis.com/v1beta/interactions", `${base}/interactions`)
      .replace("every: 5", "every: 0.1");
  p.write("profiles/seedance.yaml", withStub("seedance.yaml").replace("/tasks/${create.id}", "/tasks/${create.id}?polls=2"));
  p.write("profiles/gemini-omni.yaml", withStub("gemini-omni.yaml"));
});

afterEach(() => {
  delete process.env.ARK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  p.cleanup();
});

const seedanceFilm = (extra = "") =>
  film({
    scenes: `  - id: s1
    duration: 5
    durationPolicy: exact
    impl:
      profile: seedance
      task: text-to-video
      params: { model: doubao-seedance-1-0-pro-250528, prompt: 一名侦探走进昏暗的房间, ratio: "16:9", duration: 5${extra} }
    produces: { video: ./build/s1.mp4 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/seedance.yaml");

const geminiFilm = () =>
  film({
    scenes: `  - id: s1
    duration: 8
    durationPolicy: exact
    impl:
      profile: gemini-omni
      task: text-to-video
      params: { model: gemini-omni-1.1-flash, prompt: 日出时分的山脉航拍, aspectRatio: "9:16", resolution: 720p }
    produces: { video: ./build/s1.mp4 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/gemini-omni.yaml");

describe("http runtime", () => {
  test("async API: create, poll until done, download with credentials; plan says filmkit run", () => {
    p.write("filmkit.yaml", seedanceFilm());
    const raw = p.cli("validate");
    expect({ exit: raw.exitCode, out: raw.stdout, err: raw.stderr }).toEqual({ exit: 0, out: expect.any(String), err: "" });
    const plan = p.json<{ nodes: { id: string; executor: string }[] }>("plan");
    expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([["s1", "filmkit run"]]);

    const run = p.json<{ requests: { method: string; url: string; status: number }[] }>("run", "s1");
    expect(run.err?.errors?.map((e) => `${e.code} ${e.message} ${e.hint ?? ""}`).join("\n")).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(
      run.out!.requests!.map((r) => `${r.method} ${new URL(r.url).pathname.replace(/\/tasks\/cgt-[a-z0-9]+/, "/tasks/<id>")}`),
    ).toEqual(["POST /tasks", "GET /tasks/<id>", "GET /tasks/<id>", "GET /file.mp4"]);
    expect(existsSync(p.path("build/s1.mp4"))).toBe(true);
    expect(readFileSync(p.path("build/s1.mp4")).length).toBeGreaterThan(1000); // a real mp4 from the stub

    // The key never appears in anything filmkit prints.
    expect(JSON.stringify(run)).not.toContain("test-key");
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).not.toContain("test-key");
  }, 30_000);

  test("the lock records the produced file like any other node", () => {
    p.write("filmkit.yaml", seedanceFilm());
    expect(p.cli("run", "s1").exitCode).toBe(0);
    const lock = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    expect(lock).toMatch(/build\/s1\.mp4/);
    expect(lock).toMatch(/sha256: [0-9a-f]{64}/);
    expect(lock).not.toContain("test-key");
    // Re-running the same film is not needed: the node is ready.
    expect(p.json<{ nodes: unknown[] }>("plan").out!.nodes).toHaveLength(0);
  }, 30_000);

  test("sync API with inline base64 bytes (Gemini-shaped)", () => {
    p.write("filmkit.yaml", geminiFilm());
    const run = p.json<{ requests: unknown[] }>("run", "s1");
    expect(run.exitCode).toBe(0);
    expect(readFileSync(p.path("build/s1.mp4")).length).toBeGreaterThan(1000); // a real mp4 from the stub
    expect(run.out!.requests).toHaveLength(1);
    expect(JSON.stringify(run)).not.toContain("test-key");
  }, 30_000);

  test("a local image is inlined as base64 with its media type", () => {
    media.png(p.path("assets/first.png"), 32, 32, "0x336699");
    media.png(p.path("assets/last.png"), 32, 32, "0x996633");
    const withFrames = (lastFrame: string) =>
      film({
        scenes: `  - id: s1
    duration: 8
    durationPolicy: exact
    impl:
      profile: gemini-omni
      task: text-to-video
      params: { model: gemini-omni-1.1-flash, prompt: 从清晨到夜晚, firstFrame: ./assets/first.png, lastFrame: ${lastFrame} }
    produces: { video: ./build/s1.mp4 }`,
      }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/gemini-omni.yaml");

    // Both frames exist: the call goes out and the video lands.
    p.write("filmkit.yaml", withFrames("./assets/last.png"));
    const ok = p.json<{ requests: unknown[] }>("run", "s1");
    expect(ok.err?.errors?.map((e) => e.message).join("\n")).toBeUndefined();
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(p.path("build/s1.mp4")).length).toBeGreaterThan(1000);

    // A frame that is not in place is caught as a film-level problem, with the
    // field path, before any request is made.
    p.write("filmkit.yaml", withFrames("./assets/absent.png"));
    const missing = p.json("run", "s1");
    expect(missing.exitCode).toBe(2);
    expect(missing.err!.errors[0]!.field).toBe("scenes[0].impl.params.lastFrame");
    expect(missing.err!.errors[0]!.message).toMatch(/referenced file is not in place: \.\/assets\/absent\.png/);
    const plan = p.json<{ missingFiles: { path: string; usedBy: string[] }[] }>("plan");
    expect(plan.out!.missingFiles.map((m) => [m.path, m.usedBy])).toEqual([["./assets/absent.png", ["s1"]]]);
  }, 30_000);

  test("a missing environment variable fails before any request, naming the variable only", () => {
    delete process.env.ARK_API_KEY;
    p.write("filmkit.yaml", seedanceFilm());
    const r = p.json("run", "s1");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/environment variable ARK_API_KEY is not set/);
    expect(r.err!.errors[0]!.hint).toMatch(/filmkit never stores credentials/);
    // nothing was sent: the failure happened before the worker started
    expect(existsSync(p.path("build/s1.mp4"))).toBe(false);
  }, 30_000);

  test("HTTP failures map to the documented exit codes and leave no produce", () => {
    // 401 from the provider = credentials problem (exit 3).
    process.env.GEMINI_API_KEY = "wrong";
    p.write("filmkit.yaml", geminiFilm());
    const unauthorized = p.json("run", "s1");
    expect(unauthorized.exitCode).toBe(3);
    expect(unauthorized.err!.errors[0]!.message).toMatch(/HTTP 401/);
    expect(existsSync(p.path("build/s1.mp4"))).toBe(false);

    // A task the provider reports as failed = tool failure (exit 4), with the API's error in the hint.
    process.env.GEMINI_API_KEY = "test-key";
    p.write("filmkit.yaml", seedanceFilm());
    p.write(
      "profiles/seedance.yaml",
      readFileSync(p.path("profiles/seedance.yaml"), "utf8").replace("?polls=2", "?polls=1&fail=1"),
    );
    const failed = p.json("run", "s1");
    expect(failed.exitCode).toBe(4);
    expect(failed.err!.errors[0]!.message).toMatch(/the API reported status = "failed"/);
    expect(failed.err!.errors[0]!.hint).toMatch(/OutputVideoSensitiveContentDetected/);
    expect(existsSync(p.path("build/s1.mp4"))).toBe(false);
  }, 30_000);

  test("an inline path that does not resolve explains what came back", () => {
    p.write(
      "profiles/gemini-omni.yaml",
      readFileSync(p.path("profiles/gemini-omni.yaml"), "utf8").replace(`${base}/interactions`, `${base}/interactions?mode=missing-path`),
    );
    p.write("filmkit.yaml", geminiFilm());
    const r = p.json("run", "s1");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/http\.output\.inline: path "steps\.0\.content\.0\.data" did not resolve/);
    expect(r.err!.errors[0]!.hint).toContain('"content":[]'); // what came back, for fixing the path
  }, 30_000);

  test("doctor reports the required env variable without printing its value", () => {
    p.write("filmkit.yaml", seedanceFilm());
    const ok = p.json<{ profiles: { name: string; ok: boolean; env: { name: string; set: boolean }[] }[] }>("doctor");
    expect(ok.exitCode).toBe(0);
    const profile = ok.out!.profiles.find((x) => x.name === "seedance")!;
    expect(profile.env).toEqual([{ name: "ARK_API_KEY", set: true }]);
    expect(JSON.stringify(ok.out)).not.toContain("test-key");

    delete process.env.ARK_API_KEY;
    const missing = p.json<{ problems: string[] }>("doctor");
    expect(missing.exitCode).toBe(3);
    expect(missing.out!.problems.join("\n")).toMatch(/profile seedance: env ARK_API_KEY not set/);
    expect(JSON.stringify(missing.out)).not.toContain("test-key");
  }, 30_000);
});
