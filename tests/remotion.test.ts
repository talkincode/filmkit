// The Remotion integration: a task's `cwd` (the Remotion project directory),
// film-dir-relative params turned into absolute paths across that boundary, and
// staleness that follows the content of the tool's own project files.
//
// The `npx` on PATH is a stub here; the real CLI is exercised separately
// (see docs/roadmap.md and the manual run recorded in the round's summary).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
let stubDir: string;
let prevPath: string;

function stubNpx(): void {
  stubDir = mkdtempSync(join(tmpdir(), "filmkit-stub-npx-"));
  writeFileSync(
    join(stubDir, "npx"),
    `#!/bin/sh
cmd=""
for a in "$@"; do
  case "$a" in render|still|versions) cmd="$a" ;; esac
done
if [ -z "$cmd" ]; then echo "stub npx: unknown command" >&2; exit 1; fi
out=""
for a in "$@"; do case "$a" in --*) ;; *) out="$a" ;; esac; done
{ echo "PWD=$PWD"; echo "ARGV=$*"; } >> "$STUB_LOG"
if [ "$cmd" = "versions" ]; then echo "4.0.526"; exit 0; fi
if [ "$cmd" = "still" ]; then cp "$STUB_IMAGE" "$out"; else cp "$STUB_VIDEO" "$out"; fi
`,
    { mode: 0o755 },
  );
  prevPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${prevPath}`;
}

/** One Remotion scene (stub-rendered) + one static card, crossfaded, with looping BGM. */
function remotionFilm(params: string): string {
  return film({
    assets: `  bgm: { kind: audio, uri: ./bgm.wav }`,
    scenes: `  - id: s1
    durationPolicy: min
    duration: 4
    impl:
      profile: remotion
      task: render
      params: { project: ./video, entry: src/index.ts, composition: SceneOne, props: ./video/props/s1.json${params} }
    produces: { video: ./build/s1.mp4 }
  - id: s2
    duration: 2
    durationPolicy: exact
    transition: { type: crossfade, duration: 0.4 }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./card.png }`,
    tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/remotion.yaml");
}

function log(): string[] {
  return readFileSync(p.path("stub.log"), "utf8").trim().split("\n");
}

beforeEach(() => {
  p = project();
  p.write("profiles/remotion.yaml", readFileSync(join(import.meta.dir, "../profiles/remotion.yaml"), "utf8"));
  // The Remotion project the Profile points at.
  mkdirSync(p.path("video/src"), { recursive: true });
  mkdirSync(p.path("video/props"), { recursive: true });
  writeFileSync(p.path("video/src/index.tsx"), "export const SceneOne = 1;\n");
  writeFileSync(p.path("video/props/s1.json"), JSON.stringify({ durationInFrames: 120 }));
  media.png(p.path("card.png"));
  media.wav(p.path("bgm.wav"), 1, 220);
  media.mp4(p.path("fixture.mp4"), 4, { w: 320, h: 180, audio: true });
  media.png(p.path("fixture-still.png"), 320, 180);
  process.env.STUB_LOG = p.path("stub.log");
  process.env.STUB_VIDEO = p.path("fixture.mp4");
  process.env.STUB_IMAGE = p.path("fixture-still.png");
  stubNpx();
});

afterEach(() => {
  process.env.PATH = prevPath;
  delete process.env.STUB_LOG;
  delete process.env.STUB_VIDEO;
  delete process.env.STUB_IMAGE;
  rmSync(stubDir, { recursive: true, force: true });
  p.cleanup();
});

describe("remotion profile", () => {
  test("run renders through the project dir with absolute paths, then build composes", () => {
    writeFileSync(p.path("stub.log"), "");
    p.write("filmkit.yaml", remotionFilm(""));
    expect(p.cli("validate").exitCode).toBe(0);

    const plan = p.json<{ nodes: { id: string; executor: string; params: Record<string, unknown> }[] }>("plan");
    expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([["s1", "filmkit run"]]);

    const run = p.json<{ argv: string[] }>("run", "s1");
    expect(run.exitCode).toBe(0);
    const [pwdLine, argvLine] = log();
    // The command ran inside the Remotion project…
    // (/var is a symlink to /private/var on macOS, so compare the tail.)
    expect(pwdLine!.endsWith("/video")).toBe(true);
    expect(pwdLine).toContain(p.dir.split("/").pop()!);
    // …the entry point stays the tool's own vocabulary…
    expect(argvLine).toContain("remotion render src/index.ts SceneOne");
    // …and filmkit's paths crossed the boundary as absolute paths.
    const out = run.out!.argv.find((a) => a.endsWith("build/s1.mp4"))!;
    // (realpath: /var is a symlink to /private/var on macOS and the CLI resolves the project dir)
    expect(out).toBe(realpathSync(p.path("build/s1.mp4")));
    expect(out.startsWith("/")).toBe(true);
    expect(existsSync(p.path("build/s1.mp4"))).toBe(true);
    // Optional flags that were not set are dropped, not passed empty.
    expect(argvLine).not.toContain("--crf");
    expect(argvLine).toContain("--overwrite");
    // The props path crossed the boundary too, and was passed as an absolute path.
    expect(argvLine).toContain(`--props=${realpathSync(p.path("video/props/s1.json"))}`);

    const built = p.json<{ total: number }>("build");
    expect(built.exitCode).toBe(0);
    expect(built.out!.total).toBe(5.6); // 4 + 2 - 0.4 crossfade
    expect(probe(p.path("build/t.mp4")).duration).toBeGreaterThan(5.4);
  });

  test("optional flags appear exactly when set, and a misspelled one is refused", () => {
    writeFileSync(p.path("stub.log"), "");
    p.write("filmkit.yaml", remotionFilm(", crf: 18, scale: 0.5, log: verbose"));
    expect(p.cli("run", "s1").exitCode).toBe(0);
    const argv = log()[1]!;
    expect(argv).toContain("--crf=18");
    expect(argv).toContain("--scale=0.5");
    expect(argv).toContain("--log=verbose");
    expect(argv).not.toContain("--frames");

    // `crf` is declared, so it validates; `coodec` is not.
    p.write("filmkit.yaml", remotionFilm(", coodec: 1"));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/unknown field "coodec"/);
  });

  test("a still task produces an image the film can use as a scene", () => {
    p.write(
      "filmkit.yaml",
      film({
        scenes: `  - id: cover
    duration: 2
    durationPolicy: exact
    impl:
      profile: remotion
      task: still
      params: { project: ./video, entry: src/index.ts, composition: SceneOne, frame: 12, imageFormat: png }
    produces: { image: ./build/cover.png }`,
      }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/remotion.yaml"),
    );
    writeFileSync(p.path("stub.log"), "");
    const run = p.json<{ argv: string[] }>("run", "cover");
    expect(run.exitCode).toBe(0);
    expect(log()[1]).toContain("remotion still src/index.ts SceneOne");
    expect(log()[1]).toContain("--frame=12");
    expect(log()[1]).toContain("--image-format=png");
    expect(existsSync(p.path("build/cover.png"))).toBe(true);
    expect(p.cli("build").exitCode).toBe(0);
    expect(probe(p.path("build/t.mp4")).duration).toBeGreaterThan(1.8);
  });

  test("editing the Remotion project marks the node stale; node_modules does not", () => {
    p.write("filmkit.yaml", remotionFilm(""));
    expect(p.cli("run", "s1").exitCode).toBe(0);
    expect(p.json<{ nodes: unknown[] }>("plan").out!.nodes).toHaveLength(0);

    writeFileSync(p.path("video/src/index.tsx"), "export const SceneOne = 2;\n");
    const stale = p.json<{ nodes: { id: string; status: string; reason: string }[] }>("plan");
    expect(stale.out!.nodes.map((n) => [n.id, n.status])).toEqual([["s1", "stale"]]);
    expect(stale.out!.nodes[0]!.reason).toMatch(/impl\.params changed/);

    // Re-render clears it; touching node_modules must not invalidate it again.
    expect(p.cli("run", "s1").exitCode).toBe(0);
    mkdirSync(p.path("video/node_modules/dep"), { recursive: true });
    writeFileSync(p.path("video/node_modules/dep/index.js"), "module.exports = 1;\n");
    writeFileSync(p.path("video/node_modules/dep/index.js"), "module.exports = 2;\n");
    expect(p.json<{ nodes: unknown[] }>("plan").out!.nodes).toHaveLength(0);
  });

  test("the props file is checked and hashed: missing it blocks, changing it re-renders", () => {
    p.write("filmkit.yaml", remotionFilm(""));
    rmSync(p.path("video/props/s1.json"));
    const missing = p.json<{ missingFiles: { path: string; usedBy: string[] }[] }>("plan");
    expect(missing.out!.missingFiles.map((m) => [m.path, m.usedBy])).toEqual([["./video/props/s1.json", ["s1"]]]);
    expect(p.json("validate").exitCode).toBe(2);

    writeFileSync(p.path("video/props/s1.json"), JSON.stringify({ durationInFrames: 120 }));
    expect(p.cli("run", "s1").exitCode).toBe(0);
    expect(p.json<{ nodes: unknown[] }>("plan").out!.nodes).toHaveLength(0);
    writeFileSync(p.path("video/props/s1.json"), JSON.stringify({ durationInFrames: 150 }));
    expect(p.json<{ nodes: { id: string }[] }>("plan").out!.nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  test("a missing cwd is a file to place; escaping the project is refused", () => {
    p.write("filmkit.yaml", remotionFilm(""));
    rmSync(p.path("video"), { recursive: true, force: true });
    const plan = p.json<{ missingFiles: { path: string; field: string }[] }>("plan");
    expect(plan.out!.missingFiles.map((m) => m.path)).toContain("./video");
    const r = p.json("run", "s1");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/cwd "\.\/video" is not a directory/);

    p.write("filmkit.yaml", remotionFilm("").replace("project: ./video", "project: ../elsewhere"));
    const esc = p.json("validate");
    expect(esc.exitCode).toBe(2);
    expect(esc.err!.errors.map((e) => e.message).join("\n")).toMatch(/cwd "\.\.\/elsewhere" escapes the project directory/);
  });

  test("doctor runs the Healthcheck inside the project directory (healthcheckCwd)", () => {
    p.write("filmkit.yaml", remotionFilm(""));
    writeFileSync(p.path("stub.log"), "");
    const r = p.json<{ profiles: { name: string; ok: boolean; healthcheck?: { ok: boolean; argv: string[] } }[] }>("doctor");
    expect(r.exitCode).toBe(0);
    const remotion = r.out!.profiles.find((x) => x.name === "remotion")!;
    expect(remotion.ok).toBe(true);
    expect(remotion.healthcheck!.argv).toEqual(["npx", "--no-install", "remotion", "versions"]);
    // Remotion is only resolvable from inside its project, so that is where it ran.
    expect(log()[0]!.endsWith("/video")).toBe(true);
  });

  test("doctor reports a healthcheckCwd that is not there", () => {
    p.write("filmkit.yaml", remotionFilm(""));
    rmSync(p.path("video"), { recursive: true, force: true });
    const r = p.json<{ problems: string[] }>("doctor");
    expect(r.exitCode).toBe(3);
    expect(r.out!.problems.join("\n")).toMatch(/healthcheck cwd \.\/video does not exist/);
  });
});
