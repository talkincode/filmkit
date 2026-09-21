// The HyperFrames integration: `check` as the delegated content gate, `render`
// inside the project directory with absolute paths, a variables file that is
// checked and hashed like Remotion's props, and a doctor expectation that picks
// the one check which actually gates a render out of doctor's checks[].

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
let stubDir: string;
let prevPath: string;

/** A stub `npx` that mimics hyperframes' observable contract. */
function stubNpx(): void {
  stubDir = mkdtempSync(join(tmpdir(), "filmkit-stub-hf-"));
  writeFileSync(
    join(stubDir, "npx"),
    `#!/bin/sh
cmd=""
for a in "$@"; do case "$a" in render|check|doctor) cmd="$a" ;; esac; done
[ -z "$cmd" ] && { echo "stub npx: unknown command" >&2; exit 1; }
{ echo "PWD=$PWD"; echo "ARGV=$*"; } >> "$STUB_LOG"
case "$cmd" in
  doctor) cat "$STUB_DOCTOR"; exit 0 ;;
  check)
    if [ -f BAD ]; then echo "Lint: 3 error(s) — run with --lint-verbose for full output." >&2; exit 1; fi
    echo "check ok"; exit 0 ;;
esac
# render
out=""
for a in "$@"; do case "$a" in --output=*) out="\${a#--output=}" ;; esac; done
[ -n "$out" ] || { echo "missing --output" >&2; exit 2; }
case "$*" in *CRASH*) echo "HF_DE_COMPOSITION_ROOT_MISSING: composition root not found" >&2; exit 1 ;; esac
cp "$STUB_VIDEO" "$out"
`,
    { mode: 0o755 },
  );
  prevPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${prevPath}`;
}

function hyperframesFilm(params: string): string {
  return film({
    assets: "  bgm: { kind: audio, uri: ./bgm.wav }",
    scenes: `  - id: s1
    durationPolicy: min
    duration: 3
    intent: { description: HyperFrames 动效段 }
    impl:
      profile: hyperframes
      task: render
      params: { project: ./video, variables: ./video/vars/s1.json${params} }
    produces: { video: ./build/s1.mp4 }
  - id: s2
    duration: 2
    durationPolicy: exact
    transition: { type: crossfade, duration: 0.4 }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./card.png }`,
    tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/hyperframes.yaml");
}

const log = () => readFileSync(p.path("stub.log"), "utf8").trim().split("\n").filter(Boolean);

beforeEach(() => {
  p = project();
  p.write("profiles/hyperframes.yaml", readFileSync(join(import.meta.dir, "../profiles/hyperframes.yaml"), "utf8"));
  mkdirSync(p.path("video/vars"), { recursive: true });
  writeFileSync(p.path("video/index.html"), "<!doctype html><html><body>composition</body></html>\n");
  writeFileSync(p.path("video/vars/s1.json"), JSON.stringify({ title: "filmkit" }));
  media.png(p.path("card.png"));
  media.wav(p.path("bgm.wav"), 1, 220);
  media.mp4(p.path("fixture.mp4"), 3, { w: 640, h: 360, audio: true });
  process.env.STUB_LOG = p.path("stub.log");
  process.env.STUB_VIDEO = p.path("fixture.mp4");
  process.env.STUB_DOCTOR = p.path("doctor.json");
  writeFileSync(
    p.path("doctor.json"),
    JSON.stringify({ ok: false, platform: "darwin", checks: [
      { name: "Version", ok: true, detail: "0.8.58" },
      { name: "Chrome", ok: true, detail: "cache: ..." },
      { name: "TTS (Kokoro)", ok: false, detail: "Not installed (optional)" },
    ] }),
  );
  writeFileSync(p.path("stub.log"), "");
  stubNpx();
});

afterEach(() => {
  process.env.PATH = prevPath;
  for (const k of ["STUB_LOG", "STUB_VIDEO", "STUB_DOCTOR"]) delete process.env[k];
  rmSync(stubDir, { recursive: true, force: true });
  p.cleanup();
});

describe("hyperframes profile", () => {
  test("validate delegates to `check`, run renders inside the project, build composes", () => {
    p.write("filmkit.yaml", hyperframesFilm(""));
    expect(p.cli("validate").exitCode).toBe(0);
    expect(log()[0]!.endsWith("/video")).toBe(true); // the gate runs in the project directory
    expect(log()[1]).toContain("hyperframes check");

    const plan = p.json<{ nodes: { id: string; executor: string }[] }>("plan");
    expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([["s1", "filmkit run"]]);

    const run = p.json<{ argv: string[] }>("run", "s1");
    expect(run.exitCode).toBe(0);
    const [pwd, args] = log().slice(-2);
    expect(pwd!.endsWith("/video")).toBe(true);
    expect(args).toContain("render");
    expect(args).toContain("--output=" + realpathSync(p.path("build/s1.mp4")));
    expect(args).toContain("--variables-file=" + realpathSync(p.path("video/vars/s1.json")));
    // Unset optional flags are dropped, not passed empty.
    expect(args).not.toContain("--quality");
    expect(args).not.toContain("--composition");
    expect(existsSync(p.path("build/s1.mp4"))).toBe(true);

    const built = p.json<{ total: number }>("build");
    expect(built.exitCode).toBe(0);
    expect(built.out!.total).toBe(4.6); // 3 + 2 - 0.4
    expect(probe(p.path("build/t.mp4")).duration).toBeGreaterThan(4.4);
  });

  test("optional params reach the render; a wrong one is refused by the schema", () => {
    p.write("filmkit.yaml", hyperframesFilm(", quality: draft, composition: compositions/intro.html, fps: 25, strict: true, quiet: true"));
    expect(p.json("run", "s1").exitCode).toBe(0);
    const args = log().at(-1)!;
    expect(args).toContain("--quality=draft");
    expect(args).toContain("--composition=compositions/intro.html");
    expect(args).toContain("--fps=25");
    expect(args).toContain("--strict=true");
    expect(args).toContain("--quiet=true");

    p.write("filmkit.yaml", hyperframesFilm(", quality: ultra"));
    const bad = p.json("validate");
    expect(bad.exitCode).toBe(2);
    expect(bad.err!.errors[0]!.message).toMatch(/must be one of: draft, looks, delivery, standard, high/);
  });

  test("the project's content gate fails the film: check exit 1 → tool-failure with the findings", () => {
    writeFileSync(p.path("video/BAD"), "");
    p.write("filmkit.yaml", hyperframesFilm(""));
    const r = p.json("validate");
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.code).toBe("tool-failure");
    expect(r.err!.errors[0]!.message).toMatch(/s1: hyperframes validate: npx exited with 1/);
    expect(r.err!.errors[0]!.hint).toMatch(/Lint: 3 error\(s\)/);
    // The structural pass stays clean: the film itself is legal.
    expect(p.cli("validate", "--no-delegate").exitCode).toBe(0);
  });

  test("a failed render leaves no produce and no lock change", () => {
    p.write("filmkit.yaml", hyperframesFilm(", composition: CRASH.html"));
    p.cli("status");
    const before = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    const r = p.json("run", "s1");
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.hint).toMatch(/HF_DE_COMPOSITION_ROOT_MISSING/);
    expect(existsSync(p.path("build/s1.mp4"))).toBe(false);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(before);
  });

  test("editing the project or the variables file marks the scene stale", () => {
    p.write("filmkit.yaml", hyperframesFilm(""));
    expect(p.cli("run", "s1").exitCode).toBe(0);
    writeFileSync(p.path("video/index.html"), "<!doctype html><html><body>changed</body></html>\n");
    expect(p.json<{ nodes: { id: string; status: string }[] }>("plan").out!.nodes.map((n) => [n.id, n.status])).toEqual([["s1", "stale"]]);
    expect(p.cli("run", "s1").exitCode).toBe(0);
    writeFileSync(p.path("video/vars/s1.json"), JSON.stringify({ title: "second take" }));
    expect(p.json<{ nodes: { id: string }[] }>("plan").out!.nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  test("doctor asserts on the Chrome check, ignoring optional-feature failures", () => {
    p.write("filmkit.yaml", hyperframesFilm(""));
    const ok = p.json<{ profiles: { name: string; ok: boolean; healthcheck?: { expect?: { ok: boolean } } }[]; problems: string[] }>("doctor");
    // doctor's own `ok` is false (TTS/BGM/whisper are optional), but rendering is fine.
    expect(ok.exitCode).toBe(0);
    const hf = ok.out!.profiles.find((x) => x.name === "hyperframes")!;
    expect(hf.ok).toBe(true);
    expect(hf.healthcheck!.expect!.ok).toBe(true);
    expect(log()[0]!.endsWith("/video")).toBe(true); // healthcheckCwd

    // Without Chrome the tool cannot render, and that must surface.
    writeFileSync(
      p.path("doctor.json"),
      JSON.stringify({ ok: false, checks: [{ name: "Version", ok: true }, { name: "Chrome", ok: false, detail: "not found" }] }),
    );
    const bad = p.json<{ problems: string[] }>("doctor");
    expect(bad.exitCode).toBe(3);
    expect(bad.out!.problems.join("\n")).toMatch(/the element matching \{"name":"Chrome"\} of checks must have ok = true \(saw false\)/);
  });
});
