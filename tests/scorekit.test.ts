// The scorekit integration (docs/roadmap.md, direction "音乐与画面的结构性同步"):
// a Profile drives `filmkit run`, the agent turns the tool's own timing data into
// a `filmkit/cues-v1` file, and `fit: exact` proves the result lines up with the cuts.
//
// Two layers: a stub scorekit that always runs, and the real scorekit when it is
// installed (skipped otherwise) so the shipped profile is exercised for real.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  p.write("profiles/scorekit.yaml", readFileSync(join(import.meta.dir, "../profiles/scorekit.yaml"), "utf8"));
  media.png(p.path("a.png"));
  media.png(p.path("b.png"));
});
afterEach(() => p.cleanup());

const theme = `title: Theme
story: Test bed.
tempo: 92
key: D_minor
time_signature: "4/4"
bars: 8
sections:
  - name: open
    bars: 8
  - name: body
    bars: 8
tracks:
  - { id: harmony, instrument: strings, pattern: sustain, intensity: 0.4 }
  - { id: foundation, instrument: bass, pattern: bass, intensity: 0.45 }
`;

function filmkitYaml(extra: { track: string; planned?: string }): string {
  return film({
    assets: `  music:
    kind: audio
    impl:
      profile: scorekit
      task: build
      params: { scene: ./music/theme.yaml }
    produces: { audio: ./build/music/theme.ogg }`,
    scenes: `  - id: s1
    duration: 3
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./a.png }
  - id: s2
    duration: 4
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./b.png }`,
    tracks: `    - ${extra.track}`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/scorekit.yaml");
}

/** Put a stub `scorekit` first on PATH; it validates anything and copies a fixture. */
function stubScorekit(dir: string): () => void {
  const bin = mkdtempSync(join(tmpdir(), "filmkit-stub-sk-"));
  writeFileSync(
    join(bin, "scorekit"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    validate) exit 0 ;;
    build) ;;
  esac
done
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
cp "${dir}" "$out"
echo "scorekit stub wrote $out"
`,
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  return () => {
    process.env.PATH = prevPath;
    rmSync(bin, { recursive: true, force: true });
  };
}

describe("scorekit profile + fit: exact (stub)", () => {
  test("validate delegates to scorekit, run produces the audio, cues gate the build", () => {
    media.wav(p.path("fixture.wav"), 7.2, 300);
    const restore = stubScorekit(p.path("fixture.wav"));
    try {
      p.write("music/theme.yaml", theme);
      p.write("cues.json", JSON.stringify({ version: "filmkit/cues-v1", cues: [{ id: "open", start: 0, end: 3 }, { id: "body", start: 3, end: 7 }] }));
      p.write("filmkit.yaml", filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: exact, cues: ./cues.json }" }));

      // The Profile's `validate` template ran `scorekit --json validate`.
      expect(p.cli("validate").exitCode).toBe(0);
      const plan = p.json<{ nodes: { id: string; executor: string }[] }>("plan");
      expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([["music", "filmkit run"]]);

      const run = p.json<{ argv: string[] }>("run", "music");
      expect(run.err?.errors?.map((e) => e.message).join("\n")).toBeUndefined();
      expect(run.exitCode).toBe(0);
      expect(run.out!.argv).toEqual(["scorekit", "build", "./music/theme.yaml", "-o", "./build/music/theme.ogg"]);

      const built = p.json<{ output: string; total: number }>("build");
      expect(built.exitCode).toBe(0);
      expect(built.out!.total).toBe(7);
      expect(Math.abs(probe(p.path("build/t.mp4")).duration - 7)).toBeLessThan(0.15);

      // A tool that writes a scene the agent must keep in sync: three subcommands all clean.
      restore();
    } finally {
      restore();
    }
  });

  test("a tool-level validation failure comes back as invalid-input with the tool's stderr", () => {
    const bin = mkdtempSync(join(tmpdir(), "filmkit-stub-sk-"));
    writeFileSync(join(bin, "scorekit"), `#!/bin/sh\necho '{"code":"parse","message":"missing field \`bars\`"}' >&2\nexit 2\n`, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      p.write("music/theme.yaml", theme);
      p.write("filmkit.yaml", filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: loop }" }));
      const r = p.json("validate");
      expect(r.exitCode).toBe(2);
      expect(r.err!.errors[0]!.message).toMatch(/scorekit validate: scorekit exited with 2/);
      expect(r.err!.errors[0]!.field).toBe("assets.music.impl");
    } finally {
      process.env.PATH = prevPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("renderer, orchestration and valueless flags reach the command", () => {
    p.write("music/theme.yaml", theme);
    p.write(
      "filmkit.yaml",
      filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: loop }" }).replace(
        "params: { scene: ./music/theme.yaml }",
        "params: { scene: ./music/theme.yaml, renderer: sfizz, orchestration: ./music/orch.yaml, flags: [--stems] }",
      ),
    );
    p.write("music/orch.yaml", "profiles: {}\n"); // only needs to exist for the param check
    media.wav(p.path("fixture.wav"), 7.2, 300);
    const restore = stubScorekit(p.path("fixture.wav"));
    try {
      const run = p.json<{ argv: string[] }>("run", "music");
      expect(run.err?.errors?.map((e) => e.message).join("\n")).toBeUndefined();
      expect(run.exitCode).toBe(0);
      const argv = run.out!.argv.join(" ");
      expect(argv).toContain("--renderer=sfizz");
      expect(argv).toContain("--orchestration=./music/orch.yaml");
      expect(argv).toMatch(/ --stems$/);
    } finally {
      restore();
    }
  });

  test("doctor reports a missing scorekit without failing the project", () => {
    p.write("music/theme.yaml", theme);
    p.write("filmkit.yaml", filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: loop }" }));
    const real = Bun.which("scorekit");
    if (!real) {
      const r = p.cli("doctor", "--json");
      expect(r.exitCode).toBe(3);
      expect(JSON.parse(r.stdout).problems.join()).toMatch(/scorekit/);
    }
    // With scorekit present the same project is clean.
    const r = p.cli("doctor");
    expect(r.exitCode).toBe(real ? 0 : 3);
  });
});

const hasScorekit = Bun.which("scorekit") !== null;

describe("real scorekit", () => {
  test.skipIf(!hasScorekit)("scene -> ogg -> cues -> composed film with aligned cuts", () => {
    p.write("music/theme.yaml", theme);
    p.write("filmkit.yaml", filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: exact, cues: ./build/music/theme.cues.json }" }));

    // Before anything runs: the cue file is a missing input, so `plan` asks for it
    // and `run` is still allowed (the music has not been rendered yet).
    const plan = p.json<{ missingFiles: { path: string }[]; nodes: { id: string }[] }>("plan");
    expect(plan.out!.missingFiles.map((m) => m.path)).toEqual(["./build/music/theme.cues.json"]);
    expect(plan.out!.nodes.map((n) => n.id)).toEqual(["music"]);
    expect(p.cli("run", "music").exitCode).toBe(0);

    // The agent's step: read scorekit's own meta.json and write the neutral cue file.
    const meta = JSON.parse(readFileSync(p.path("build/music/theme.meta.json"), "utf8")) as {
      sample_rate: number;
      sections: { name: string; seconds: number }[];
    };
    let t = 0;
    const cues = meta.sections.map((s) => {
      const cue = { id: s.name, start: round(t), end: round(t + s.seconds) };
      t += s.seconds;
      return cue;
    });
    p.write("build/music/theme.cues.json", JSON.stringify({ version: "filmkit/cues-v1", cues }));

    // Scene durations come from the same numbers, so the cuts land on the section boundaries.
    p.write(
      "filmkit.yaml",
      filmkitYaml({ track: "{ id: music, kind: audio, asset: music, fit: exact, cues: ./build/music/theme.cues.json }" })
        .replace("    duration: 3\n", `    duration: ${round(cues[0]!.end - cues[0]!.start)}\n`)
        .replace("    duration: 4\n", `    duration: ${round(cues[1]!.end - cues[1]!.start)}\n`),
    );
    const v = p.json("validate");
    expect(v.err?.errors.map((e) => e.message).join("\n")).toBeUndefined();
    expect(v.exitCode).toBe(0);

    const built = p.json<{ total: number }>("build");
    expect(built.exitCode).toBe(0);
    expect(built.out!.total).toBeCloseTo(meta.sections[0]!.seconds + meta.sections[1]!.seconds, 2);
    expect(Math.abs(probe(p.path("build/t.mp4")).duration - built.out!.total)).toBeLessThan(0.2);

    // And the check really bites: shift one boundary by half a second and it fails.
    // Shift the boundary 0.5s later but keep the list ordered, so what fails is
    // the alignment against the picture cut, not the cue file's own ordering.
    p.write(
      "build/music/theme.cues.json",
      JSON.stringify({
        version: "filmkit/cues-v1",
        cues: [cues[0]!, { ...cues[1]!, start: round(cues[0]!.end + 0.5) }],
      }),
    );
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/cue boundary/);
  }, 120_000);
});

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
