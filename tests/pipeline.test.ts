// End-to-end: plan -> run -> build -> status with real ffmpeg, plus the
// failure-recovery paths AGENTS.md requires for state-mutating commands.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { breakFfmpeg, film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => {
  p = project();
  media.png(p.path("assets/a.png"), 100, 100); // square: exercises contain padding
  media.png(p.path("assets/logo.png"), 40, 20, "0xffffff");
  media.wav(p.path("assets/voice.wav"), 2.5);
  media.wav(p.path("assets/bgm.wav"), 1.0, 220); // shorter than the film: exercises loop
  media.mp4(p.path("assets/clip.mp4"), 1.5, { audio: true });
  media.mp4(p.path("assets/clip2.mp4"), 2.0);
  p.write("assets/voice.srt", "1\n00:00:00,200 --> 00:00:01,000\nhello\n\n2\n00:00:01,500 --> 00:00:09,000\nlate cue clipped\n");
});
afterEach(() => p.cleanup());

/** Image+voice+srt scene (min), an mp4 scene (auto, keep own audio), crossfade, bgm loop, overlay, sidecar subs. */
const fullFilm = film({
  assets: `  bgm: { kind: audio, uri: ./assets/bgm.wav }
  logo: { kind: image, uri: ./assets/logo.png }
  tone:
    kind: audio
    impl:
      profile: filmkit/ffmpeg
      task: exec
      params: { args: ["-f", "lavfi", "-i", "sine=frequency=880:duration=1", "\${produces.audio}"] }
    produces: { audio: ./build/gen/tone.wav }`,
  scenes: `  - id: intro
    duration: 2
    durationPolicy: min
    intent: { description: "Opening card", narration: { text: hello } }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/a.png, audio: ./assets/voice.wav, subtitle: ./assets/voice.srt }
  - id: footage
    transition: { type: crossfade, duration: 0.4 }
    impl: { profile: filmkit/static, task: clip }
    produces: { video: ./assets/clip.mp4 }
  - id: outro
    duration: 1
    durationPolicy: exact
    inputs: [tone]
    impl: { profile: filmkit/ffmpeg, task: exec, params: { args: ["-i", "./assets/clip2.mp4", "-i", "\${inputs.tone}", "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "copy", "\${produces.video}"] } }
    produces: { video: ./build/gen/outro.mp4 }`,
  tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.3, fadeOut: 0.5 }
    - { id: subs, kind: subtitles, source: scenes, mode: sidecar }
    - { id: mark, kind: overlay, asset: logo, position: bottom-right, width: 40, opacity: 0.7, from: 0.5 }`,
});

interface PlanJson {
  timeline: { total: number; scenes: { id: string; start: number; end: number; duration: number; estimated: boolean }[] };
  nodes: { id: string; status: string; executor: string; reason: string; produces: Record<string, string> }[];
}

describe("plan", () => {
  test("lists only unready nodes in dependency order with executors", () => {
    p.write("filmkit.yaml", fullFilm);
    const r = p.json<PlanJson>("plan");
    expect(r.exitCode).toBe(0);
    const ids = r.out!.nodes.map((n) => n.id);
    expect(ids).toEqual(["tone", "outro"]);
    expect(r.out!.nodes[0]!.executor).toBe("filmkit run");
    expect(r.out!.nodes[1]!.status).toBe("missing");
    expect(r.out!.nodes[1]!.reason).toMatch(/missing produces: video/);
    expect(r.out!.nodes[1]!.reason).toMatch(/input node is not ready/);
    // Timeline: intro = max(2, 2.5 voice) = 2.5; footage auto = 1.5 with 0.4 crossfade; outro exact 1.
    const tl = r.out!.timeline;
    expect(tl.scenes.map((s) => [s.id, s.start, s.end])).toEqual([["intro", 0, 2.5], ["footage", 2.1, 3.6], ["outro", 3.6, 4.6]]);
    expect(tl.total).toBe(4.6);
    expect(tl.scenes.filter((s) => s.estimated).map((s) => s.id)).toEqual(["outro"]); // outro's video does not exist yet
  });

  test("marks durations as estimated while media is missing", () => {
    p.write("filmkit.yaml", film({ scenes: `  - id: s1\n    duration: 3\n    impl: { profile: filmkit/static, task: clip }\n    produces: { video: ./build/s1.mp4 }` }));
    const r = p.json<PlanJson>("plan");
    expect(r.out!.timeline.scenes[0]!.estimated).toBe(true);
    expect(r.out!.nodes[0]!.executor).toBe("place files");
  });

  test("a changed impl.params marks a recorded node stale and only that node", () => {
    p.write("filmkit.yaml", fullFilm);
    expect(p.cli("run", "tone").exitCode).toBe(0);
    expect(p.cli("run", "outro").exitCode).toBe(0);
    expect(p.json<PlanJson>("plan").out!.nodes).toHaveLength(0);
    p.write("filmkit.yaml", fullFilm.replace("frequency=880", "frequency=990"));
    const r = p.json<PlanJson>("plan");
    expect(r.out!.nodes.map((n) => [n.id, n.status])).toEqual([["tone", "stale"], ["outro", "blocked"]]);
  });
});

describe("run", () => {
  test("executes a cli node, creates produces, records the lock", () => {
    p.write("filmkit.yaml", fullFilm);
    const r = p.json<{ id: string; argv: string[] }>("run", "tone");
    expect(r.exitCode).toBe(0);
    expect(r.out!.argv.slice(0, 3)).toEqual(["ffmpeg", "-hide_banner", "-y"]);
    expect(r.out!.argv.at(-1)).toBe("./build/gen/tone.wav");
    expect(existsSync(p.path("build/gen/tone.wav"))).toBe(true);
    const lock = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    expect(lock).toMatch(/tone:\n\s+kind: asset\n\s+status: ready/);
    expect(lock).not.toMatch(/timestamp|date/i);
  });

  test("refuses non-cli nodes with a pointer to the agent", () => {
    p.write("filmkit.yaml", fullFilm);
    const r = p.json("run", "intro");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/only executes cli profiles/);
  });

  test("unknown id", () => {
    p.write("filmkit.yaml", fullFilm);
    expect(p.json("run", "ghost").exitCode).toBe(2);
  });

  test("failure: tool exits non-zero -> exit 4, no produce left behind, lock unchanged", () => {
    p.write("filmkit.yaml", fullFilm);
    p.cli("status"); // create a lock to compare against
    const before = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    const restore = breakFfmpeg();
    try {
      const r = p.json("run", "tone");
      expect(r.exitCode).toBe(4);
      expect(r.err!.errors[0]!.code).toBe("tool-failure");
      expect(r.err!.errors[0]!.message).toMatch(/exited with 187/);
    } finally {
      restore();
    }
    expect(existsSync(p.path("build/gen/tone.wav"))).toBe(false);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(before);
  });

  test("failure: command succeeds but does not create produces", () => {
    // The template literal already turned "\${produces.audio}" into "${produces.audio}".
    p.write("filmkit.yaml", fullFilm.replace('"${produces.audio}"', '"-f", "null", "-"'));
    const r = p.json("run", "tone");
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.message).toMatch(/produces.audio was not created/);
  });
});

describe("build", () => {
  test("refuses while a node is not ready", () => {
    p.write("filmkit.yaml", fullFilm);
    const r = p.json("build");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors.map((e) => e.message).join()).toMatch(/"tone" is missing/);
    expect(existsSync(p.path("build/t.mp4"))).toBe(false);
  });

  test("composes a spec-conformant mp4 with crossfade, bgm loop, overlay and merged sidecar srt", () => {
    p.write("filmkit.yaml", fullFilm);
    expect(p.cli("run", "tone").exitCode).toBe(0);
    expect(p.cli("run", "outro").exitCode).toBe(0);
    const r = p.json<{ output: string; total: number; subtitles: string; warnings: string[] }>("build");
    expect(r.exitCode).toBe(0);
    expect(r.out!.total).toBe(4.6);
    const pr = probe(p.path("build/t.mp4"));
    expect([pr.width, pr.height, pr.fps, pr.vcodec, pr.acodec, pr.sampleRate, pr.channels]).toEqual([320, 180, 25, "h264", "aac", 48000, 2]);
    expect(Math.abs(pr.duration - 4.6)).toBeLessThan(0.15);
    expect(pr.format).toContain("mp4");
    // Sidecar subtitles shifted into the film timeline and clipped to the scene.
    const srt = readFileSync(p.path("build/t.srt"), "utf8");
    expect(srt).toContain("00:00:00,200 --> 00:00:01,000");
    expect(srt).toContain("00:00:01,500 --> 00:00:02,500");
    // The intro's second cue runs past the scene window, which is now reported.
    expect(r.out!.warnings).toHaveLength(1);
    expect(r.out!.warnings[0]).toMatch(/subtitle cue in intro at 1.5s runs past 2.5s and was clipped/);
    // Filtergraph is written and mentions every stage.
    const fg = readFileSync(p.path("build/compose.filtergraph.txt"), "utf8");
    for (const s of ["xfade=transition=fade:duration=0.4:offset=2.1", "acrossfade", "-stream_loop -1", "overlay=main_w-overlay_w-", "amix=inputs=2", "concat=n=2"]) expect(fg).toContain(s);
    // Lock records the build.
    const lock = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    expect(lock).toMatch(/build:\n\s+filmSha256: [0-9a-f]{64}\n\s+output:\n\s+path: \.\/build\/t\.mp4/);
    expect(lock).toContain("draft: false");
  });

  test("is deterministic: the filtergraph text is byte-identical across builds", () => {
    p.write("filmkit.yaml", fullFilm);
    p.cli("run", "tone");
    p.cli("run", "outro");
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    const first = readFileSync(p.path("build/compose.filtergraph.txt"), "utf8");
    expect(p.cli("build", "--dry-run").exitCode).toBe(0);
    expect(readFileSync(p.path("build/compose.filtergraph.txt"), "utf8")).toBe(first);
    expect(first).not.toMatch(p.dir); // relative paths only
    expect(existsSync(p.path("build/t.mp4"))).toBe(false); // dry run executes nothing
  });

  test("--draft writes a small .draft file and does not touch the final path", () => {
    p.write("filmkit.yaml", fullFilm);
    p.cli("run", "tone");
    p.cli("run", "outro");
    const r = p.json<{ output: string; draft: boolean }>("build", "--draft");
    expect(r.exitCode).toBe(0);
    expect(r.out!.output).toBe("./build/t.draft.mp4");
    expect(existsSync(p.path("build/t.mp4"))).toBe(false);
    expect(probe(p.path("build/t.draft.mp4")).width).toBe(320); // already <= 480 wide
  });

  test("embed mode adds a subtitle stream", () => {
    p.write("filmkit.yaml", fullFilm.replace("mode: sidecar", "mode: embed"));
    p.cli("run", "tone");
    p.cli("run", "outro");
    expect(p.cli("build").exitCode).toBe(0);
    const r = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "s", "-show_entries", "stream=codec_name", "-of", "csv=p=0", p.path("build/t.mp4")]);
    expect(r.stdout.toString().trim()).toBe("mov_text");
  });

  test("exact policy trims a longer clip; explicit start inserts a gap", () => {
    p.write(
      "filmkit.yaml",
      film({
        scenes: `  - id: a
    duration: 0.5
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { video: ./assets/clip.mp4 }
  - id: b
    start: 1.5
    duration: 1
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/a.png }`,
      }),
    );
    const plan = p.json<PlanJson>("plan");
    expect(plan.out!.timeline.scenes.map((s) => [s.start, s.end])).toEqual([[0, 0.5], [1.5, 2.5]]);
    expect(p.cli("build").exitCode).toBe(0);
    expect(Math.abs(probe(p.path("build/t.mp4")).duration - 2.5)).toBeLessThan(0.15);
    expect(readFileSync(p.path("build/compose.filtergraph.txt"), "utf8")).toContain("gap before b");
  });

  test("failure: ffmpeg crash mid-build leaves no output and the lock unchanged", () => {
    p.write("filmkit.yaml", fullFilm);
    p.cli("run", "tone");
    p.cli("run", "outro");
    const before = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    const restore = breakFfmpeg();
    try {
      const r = p.json("build");
      expect(r.exitCode).toBe(4);
      expect(r.err!.errors[0]!.message).toMatch(/exited with 187/);
    } finally {
      restore();
    }
    expect(existsSync(p.path("build/t.mp4"))).toBe(false);
    expect(existsSync(p.path("build/.tmp/t.mp4"))).toBe(false);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(before);
  });

  test("failure: output that violates the spec is rejected and not placed", () => {
    // Simulate an encoder that ignores the requested geometry: a fake ffprobe that
    // reports the wrong width. filmkit must refuse to place the file and leave the lock alone.
    p.write("filmkit.yaml", fullFilm);
    p.cli("run", "tone");
    p.cli("run", "outro");
    const before = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    const fake = project();
    fake.write("ffprobe", `#!/bin/sh\nexec /usr/bin/env PATH="${process.env.PATH}" ffprobe "$@" | sed 's/"width": 320/"width": 322/'\n`);
    Bun.spawnSync(["chmod", "+x", fake.path("ffprobe")]);
    const prev = process.env.PATH;
    process.env.PATH = `${fake.dir}:${prev}`;
    try {
      const r = p.json("build");
      expect(r.exitCode).toBe(4);
      expect(r.err!.errors[0]!.message).toMatch(/output resolution: expected 320x180, got 322x180/);
    } finally {
      process.env.PATH = prev;
      fake.cleanup();
    }
    expect(existsSync(p.path("build/t.mp4"))).toBe(false);
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(before);
  });
});

describe("status", () => {
  test("writes the lock and reports readiness; a re-run is idempotent", () => {
    p.write("filmkit.yaml", fullFilm);
    const r = p.json<{ nodes: { id: string; status: string }[]; timeline: { complete: boolean } }>("status");
    expect(r.exitCode).toBe(0);
    expect(r.out!.nodes.map((n) => n.status)).toEqual(["missing", "ready", "ready", "missing"]);
    expect(r.out!.timeline.complete).toBe(false);
    const a = readFileSync(p.path("filmkit.lock.yaml"), "utf8");
    p.cli("status");
    expect(readFileSync(p.path("filmkit.lock.yaml"), "utf8")).toBe(a);
  });

  test("detects an outdated build after the film changes", () => {
    p.write("filmkit.yaml", fullFilm);
    p.cli("run", "tone");
    p.cli("run", "outro");
    p.cli("build");
    expect(p.json<{ build: { upToDate: boolean } }>("status").out!.build.upToDate).toBe(true);
    p.write("filmkit.yaml", fullFilm.replace("volume: 0.3", "volume: 0.2"));
    expect(p.json<{ build: { upToDate: boolean } }>("status").out!.build.upToDate).toBe(false);
  });

  test("failure: a malformed lock is an error, not silently replaced", () => {
    p.write("filmkit.yaml", fullFilm);
    writeFileSync(p.path("filmkit.lock.yaml"), "apiVersion: filmkit/v1alpha1\nkind: Lock\nnodes: 5\n");
    const r = p.json("status");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toMatch(/filmkit.lock.yaml/);
  });
});

describe("doctor", () => {
  test("reports ffmpeg, filters and profile requirements without printing env values", () => {
    p.write("profiles/tool.yaml", `apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: tool, version: "1" }
runtime:
  type: cli
  binary: definitely-not-installed-xyz
  requires: { env: [FILMKIT_TEST_SECRET] }
tasks:
  go: { paramsSchema: { type: object } }
`);
    p.write("filmkit.yaml", fullFilm.replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/tool.yaml"));
    process.env.FILMKIT_TEST_SECRET = "hunter2";
    try {
      const r = p.cli("doctor", "--json");
      expect(r.exitCode).toBe(3);
      expect(r.stdout).not.toContain("hunter2");
      const j = JSON.parse(r.stdout) as { ffmpeg: { found: boolean }; profiles: { name: string; ok: boolean; env: { name: string; set: boolean }[] }[]; problems: string[] };
      expect(j.ffmpeg.found).toBe(true);
      const tool = j.profiles.find((x) => x.name === "tool")!;
      expect(tool.ok).toBe(false);
      expect(tool.env).toEqual([{ name: "FILMKIT_TEST_SECRET", set: true }]);
      expect(j.problems.join()).toMatch(/definitely-not-installed-xyz not found/);
    } finally {
      delete process.env.FILMKIT_TEST_SECRET;
    }
  });

  test("passes with builtins only", () => {
    p.write("filmkit.yaml", fullFilm);
    expect(p.cli("doctor").exitCode).toBe(0);
  });
});

describe("init + schema", () => {
  test("init output validates and builds end to end with nothing but ffmpeg", () => {
    const q = project();
    try {
      expect(q.cli("init", q.dir).exitCode).toBe(0);
      expect(q.cli("validate").exitCode).toBe(0);
      expect(q.cli("run", "bgm").exitCode).toBe(0);
      expect(q.cli("build").exitCode).toBe(0);
      expect(statSync(q.path("build/" + q.dir.split("/").pop()!.toLowerCase().replace(/[^a-z0-9-]/g, "-") + ".mp4")).size).toBeGreaterThan(1000);
    } finally {
      q.cleanup();
    }
  });

  test("init refuses a non-empty directory", () => {
    const r = p.json("init", p.dir);
    expect(r.exitCode).toBe(1);
    expect(r.err!.errors[0]!.message).toMatch(/not empty/);
  });

  test("schema exports load in a Draft 2020-12 validator and accept the fixtures", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    for (const flag of [[], ["--profile"], ["--lock"]]) {
      const r = p.json<Record<string, unknown>>("schema", ...flag);
      expect(r.exitCode).toBe(0);
      expect(r.out!.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(() => new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(r.out!)).not.toThrow();
    }
  });
});

describe("profiles", () => {
  test("a local cli profile with validate + invocation templates is delegated to and run", () => {
    // `validate` template that fails when params.mode is "bad"; `invocation` copies an input.
    p.write("tools/check.sh", "#!/bin/sh\n[ \"$1\" != bad ]\n");
    Bun.spawnSync(["chmod", "+x", p.path("tools/check.sh")]);
    p.write("profiles/copier.yaml", `apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: copier, version: "1" }
runtime: { type: cli, binary: cp, exitCodes: { "0": ok } }
tasks:
  copy:
    paramsSchema: { type: object, required: [mode], properties: { mode: { type: string } } }
    produces: [image]
    validate: ["./tools/check.sh", "\${params.mode}"]
    invocation: ["cp", "\${inputs.src}", "\${produces.image}"]
`);
    const yaml = (mode: string) => film({
      assets: "  src: { kind: image, uri: ./assets/a.png }",
      scenes: `  - id: s1
    duration: 1
    inputs: [src]
    impl: { profile: copier, task: copy, params: { mode: ${mode} } }
    produces: { image: ./build/s1.png }`,
    }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/copier.yaml");
    p.write("filmkit.yaml", yaml("bad"));
    const bad = p.json("validate");
    // The script exits 1 and the Profile does not map it, so the failure is the
    // tool's (exit 4), not a verdict on the film's input.
    expect(bad.exitCode).toBe(4);
    expect(bad.err!.errors[0]!.code).toBe("tool-failure");
    expect(bad.err!.errors[0]!.message).toMatch(/copier validate/);

    // Declaring the mapping is what makes a validator's failure an `invalid-input`.
    p.write("profiles/copier.yaml", readFileSync(p.path("profiles/copier.yaml"), "utf8").replace('{ "0": ok }', '{ "0": ok, "1": invalid-input }'));
    const bad2 = p.json("validate");
    expect(bad2.exitCode).toBe(2);
    expect(bad2.err!.errors[0]!.code).toBe("invalid-input");
    expect(p.json("validate", "--no-delegate").exitCode).toBe(0);
    p.write("filmkit.yaml", yaml("good"));
    expect(p.json("validate").exitCode).toBe(0);
    expect(p.json("run", "s1").exitCode).toBe(0);
    expect(existsSync(p.path("build/s1.png"))).toBe(true);
    expect(p.cli("build").exitCode).toBe(0);
  });

  test("profile documents are validated: reserved name, bad paramsSchema, invocation on non-cli", () => {
    const base = (body: string) => `apiVersion: filmkit/v1alpha1\nkind: Profile\n${body}`;
    const cases: [string, RegExp][] = [
      [base('metadata: { name: filmkit/x, version: "1" }\nruntime: { type: none }\ntasks: { t: { paramsSchema: { type: object } } }'), /reserved/],
      [base('metadata: { name: x, version: "1" }\nruntime: { type: none }\ntasks: { t: { paramsSchema: { type: object, properties: { a: { type: nope } } } } }'), /cannot be compiled/],
      [base('metadata: { name: x, version: "1" }\nruntime: { type: skill }\ntasks: { t: { paramsSchema: { type: object }, invocation: [echo] } }'), /runtime.type is "skill"/],
      [base('metadata: { name: x, version: "1" }\nruntime: { type: cli }\ntasks: { t: { paramsSchema: { type: object } } }'), /missing required field "binary"/],
    ];
    for (const [text, re] of cases) {
      p.write("profiles/x.yaml", text);
      p.write("filmkit.yaml", film({ scenes: `  - id: s1\n    duration: 1\n    impl: { profile: filmkit/static, task: clip }\n    produces: { image: ./assets/a.png }` }).replace("  - ref: filmkit/ffmpeg", "  - ref: ./profiles/x.yaml"));
      const r = p.json("validate");
      expect(r.exitCode).toBe(2);
      expect(r.err!.errors.map((e) => e.message).join("\n")).toMatch(re);
    }
  });

  test("<name>@<version> resolves from FILMKIT_HOME", () => {
    const home = project();
    try {
      home.write("profiles/echoer@1.yaml", `apiVersion: filmkit/v1alpha1\nkind: Profile\nmetadata: { name: echoer, version: "1" }\nruntime: { type: none }\ntasks: { t: { paramsSchema: { type: object } } }\n`);
      process.env.FILMKIT_HOME = home.dir;
      p.write("filmkit.yaml", film({ scenes: `  - id: s1\n    duration: 1\n    impl: { profile: echoer, task: t }\n    produces: { image: ./assets/a.png }` }).replace("  - ref: filmkit/ffmpeg", "  - ref: echoer@1"));
      expect(p.json("validate").exitCode).toBe(0);
      const missing = p.json("validate", "--film", "./filmkit.yaml");
      expect(missing.exitCode).toBe(0);
      p.write("filmkit.yaml", readFileSync(p.path("filmkit.yaml"), "utf8").replace("echoer@1", "echoer@2"));
      expect(p.json("validate").err!.errors[0]!.message).toMatch(/not found in/);
    } finally {
      delete process.env.FILMKIT_HOME;
      home.cleanup();
    }
  });
});

describe("release surface", () => {
  test("--version and -V print the package version; doctor reports it too", () => {
    const long = p.cli("--version");
    const short = p.cli("-V");
    expect(long.exitCode).toBe(0);
    expect(long.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(short.stdout).toBe(long.stdout);
    // The version comes from package.json, so a release cannot ship a stale number.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(long.stdout.trim()).toBe(pkg.version);

    const doctor = p.json<{ version: string }>("doctor");
    expect(doctor.out!.version).toBe(pkg.version);
    expect(p.cli("doctor").stdout).toContain(`filmkit ${pkg.version}`);
  });

  test("--help lists --version", () => {
    expect(p.cli("--help").stdout).toContain("--version, -V");
  });
});
