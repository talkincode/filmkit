// The imagine integration (https://github.com/talkincode/imagine): a generation
// task whose `validate` is a free `--dry-run` pre-flight, and a healthcheck that
// has to look at the tool's JSON because imagine exits 0 even when no model is
// configured — the case `healthcheckExpect` exists for.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { film, media, probe, project, type Project } from "./helpers.ts";

let p: Project;
let stubDir: string;
let prevPath: string;
let readyModels: string;

/** A stub `imagine` that mimics the real CLI's observable contract. */
function stubImagine(): void {
  stubDir = mkdtempSync(join(tmpdir(), "filmkit-stub-imagine-"));
  writeFileSync(
    join(stubDir, "imagine"),
    `#!/bin/sh
{ echo "ARGV=$*"; } >> "$STUB_LOG"
case "$1" in
  models) cat "$STUB_MODELS"; exit 0 ;;
  version) echo "imagine 0.2.0"; exit 0 ;;
esac
# generate / text render: pull the output path and the prompt out of the argv
out=""
prompt=""
for a in "$@"; do
  case "$a" in
    --output=*) out="\${a#--output=}" ;;
    --prompt=*) prompt="\${a#--prompt=}" ;;
  esac
done
for a in "$@"; do
  case "$a" in
    --dry-run) echo "dry run (no API call)"; exit 0 ;;
    *BAD_USAGE*) echo "usage error: unsupported option" >&2; exit 2 ;;
    *NO_CREDENTIAL*) echo "no credential configured for model" >&2; exit 1 ;;
  esac
done
[ -z "$prompt" ] && { echo "missing required option: --prompt" >&2; exit 2; }
[ -n "$out" ] || { echo "missing required option: --output" >&2; exit 2; }
cp "$STUB_IMAGE" "$out"
echo "wrote $out"
`,
    { mode: 0o755 },
  );
  prevPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${prevPath}`;
}

function imagineFilm(params: string): string {
  return film({
    assets: "  bgm: { kind: audio, uri: ./bgm.wav }",
    scenes: `  - id: s1
    duration: 3
    durationPolicy: exact
    intent: { description: 生成的主视觉 }
    impl:
      profile: imagine
      task: generate
      params: { prompt: "a dark corridor", size: 1024x1024${params} }
    produces: { image: ./build/s1.png }`,
    tracks: `    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2 }`,
  }).replace("  - ref: filmkit/ffmpeg", "  - ref: filmkit/ffmpeg\n  - ref: ./profiles/imagine.yaml");
}

const setModels = (models: { name: string; ready: boolean }[]) => writeFileSync(readyModels, JSON.stringify(models));

beforeEach(() => {
  p = project();
  p.write("profiles/imagine.yaml", readFileSync(join(import.meta.dir, "../profiles/imagine.yaml"), "utf8"));
  media.wav(p.path("bgm.wav"), 1, 220);
  media.png(p.path("generated.png"), 320, 180, "0x224466");
  readyModels = p.path("models.json");
  setModels([{ name: "MAI-Image-2.6", ready: true }]);
  process.env.STUB_LOG = p.path("stub.log");
  process.env.STUB_IMAGE = p.path("generated.png");
  process.env.STUB_MODELS = readyModels;
  writeFileSync(p.path("stub.log"), "");
  stubImagine();
});

afterEach(() => {
  process.env.PATH = prevPath;
  for (const k of ["STUB_LOG", "STUB_IMAGE", "STUB_MODELS"]) delete process.env[k];
  rmSync(stubDir, { recursive: true, force: true });
  p.cleanup();
});

const log = () => readFileSync(p.path("stub.log"), "utf8").trim().split("\n").filter(Boolean);

describe("imagine profile", () => {
  test("validate is a free --dry-run pre-flight; run writes the image; build composes", () => {
    p.write("filmkit.yaml", imagineFilm(""));
    expect(p.cli("validate").exitCode).toBe(0);
    const dryRun = log()[0]!;
    expect(dryRun).toContain("generate --prompt=a dark corridor --dry-run");
    expect(dryRun).not.toContain("--output"); // nothing is written during validation

    const plan = p.json<{ nodes: { id: string; executor: string }[] }>("plan");
    expect(plan.out!.nodes.map((n) => [n.id, n.executor])).toEqual([["s1", "filmkit run"]]);

    const run = p.json<{ argv: string[] }>("run", "s1");
    expect(run.exitCode).toBe(0);
    const argv = run.out!.argv.join(" ");
    expect(argv).toContain("--output=./build/s1.png"); // no cwd: paths stay film-dir-relative
    expect(argv).toContain("--size=1024x1024");
    expect(argv).toContain("--quiet");
    expect(argv).not.toContain("--quality"); // unset optional flags are dropped
    expect(existsSync(p.path("build/s1.png"))).toBe(true);

    const built = p.json<{ total: number }>("build");
    expect(built.exitCode).toBe(0);
    expect(Math.abs(probe(p.path("build/t.mp4")).duration - 3)).toBeLessThan(0.2);
  });

  test("optional params are passed; a wrong model fails the pre-flight without touching the API", () => {
    p.write("filmkit.yaml", imagineFilm(", model: MAI-Image-2.6, quality: high, seed: 7"));
    expect(p.cli("validate").exitCode).toBe(0);
    expect(log()[0]).toContain("--model=MAI-Image-2.6");
    expect(p.cli("run", "s1").exitCode).toBe(0);
    const argv = log().at(-1)!;
    expect(argv).toContain("--quality=high");
    expect(argv).toContain("--seed=7");

    // A param the schema does not declare never reaches the tool.
    p.write("filmkit.yaml", imagineFilm(", model: MAI-Image-2.6, n: 4"));
    const bad = p.json("validate");
    expect(bad.exitCode).toBe(2);
    expect(bad.err!.errors[0]!.message).toMatch(/unknown field "n"/);
  });

  test("a missing credential surfaces as tool-failure with no produce left behind", () => {
    p.write("filmkit.yaml", imagineFilm(", model: NO_CREDENTIAL"));
    const r = p.json("run", "s1");
    expect(r.exitCode).toBe(4);
    expect(r.err!.errors[0]!.message).toMatch(/imagine exited with 1/);
    expect(r.err!.errors[0]!.hint).toMatch(/no credential configured/);
    expect(existsSync(p.path("build/s1.png"))).toBe(false);
  });

  test("the tool's usage errors (exit 2) surface as invalid-input during validate", () => {
    p.write("filmkit.yaml", imagineFilm(", model: BAD_USAGE"));
    const r = p.json("validate");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors.map((e) => `${e.field}: ${e.message}`).join("\n")).toMatch(/scenes\[0\]\.impl: s1: imagine validate: imagine exited with 2/);
    expect(r.err!.errors[0]!.code).toBe("invalid-input"); // the tool classified it as bad input
    expect(r.err!.errors[0]!.hint).toMatch(/usage error: unsupported option/);
    // `run` delegates the same pre-flight first, so it refuses too.
    expect(p.json("run", "s1").exitCode).toBe(2);
  });

  test("doctor: no ready model is a problem, a ready model is fine, and no key is ever printed", () => {
    p.write("filmkit.yaml", imagineFilm(""));
    process.env.AZURE_OPENAI_APIKEY = "super-secret-value";
    try {
      const ok = p.json<{ profiles: { name: string; ok: boolean; healthcheck?: { ok: boolean; expect?: { path: string; equals: unknown; ok: boolean } } }[]; problems: string[] }>("doctor");
      expect(ok.exitCode).toBe(0);
      const imagine = ok.out!.profiles.find((x) => x.name === "imagine")!;
      expect(imagine.healthcheck!.ok).toBe(true);
      expect(imagine.healthcheck!.expect).toEqual({ path: "ready", equals: true, ok: true });
      expect(process.env.AZURE_OPENAI_APIKEY).toBe("super-secret-value");
      expect(JSON.stringify(ok.out)).not.toContain("super-secret-value");

      // The tool keeps exiting 0, but nothing is ready: doctor must say so.
      setModels([{ name: "MAI-Image-2.6", ready: false }]);
      const bad = p.json<{ ok: boolean; problems: string[] }>("doctor");
      expect(bad.exitCode).toBe(3);
      expect(bad.out!.problems.join("\n")).toMatch(/does not satisfy healthcheckExpect \(any element of the output must have ready = true \(saw false\)\)/);
      expect(JSON.stringify(bad.out)).not.toContain("super-secret-value");
    } finally {
      delete process.env.AZURE_OPENAI_APIKEY;
    }
  });

  test("doctor reports a healthcheck that is not JSON at all", () => {
    p.write(
      "filmkit.yaml",
      readFileSync(p.path("profiles/imagine.yaml"), "utf8").includes('healthcheck: ["imagine", "models", "--json"]')
        ? imagineFilm("").replace('["imagine", "models", "--json"]', '["imagine", "version"]')
        : imagineFilm(""),
    );
    p.write("profiles/imagine.yaml", readFileSync(p.path("profiles/imagine.yaml"), "utf8").replace('["imagine", "models", "--json"]', '["imagine", "version"]'));
    const r = p.json<{ problems: string[] }>("doctor");
    expect(r.exitCode).toBe(3);
    expect(r.out!.problems.join("\n")).toMatch(/healthcheck did not print JSON/);
  });
});
