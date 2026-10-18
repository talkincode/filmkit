// `colab-comfy validate`, the command filmkit runs as the Profile's delegated validate.
// In-process through main() for breadth, plus one real subprocess for the executable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { fakePng, tmpProject } from "./support.ts";

let p: ReturnType<typeof tmpProject>;
beforeAll(() => {
  p = tmpProject();
  p.write("refs/a.png", fakePng("a"));
  p.write("refs/b.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));
  p.write("refs/c.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
  p.write("refs/doc.txt", "not an image");
});
afterAll(() => p.cleanup());

const GOOD_FLAGS: Record<string, string> = {
  node: "s1a",
  template: "h3-ref2va@1",
  prompt: "The woman from <Picture 1> talks.",
  ref: "./refs/a.png",
  seed: "20261017",
  duration: "4.05",
  resolution: "704x1280",
  out: "./build/h3/s1a.mp4",
  record: "./build/h3/s1a.colab.json",
};
const GOOD = ["validate", ...Object.entries(GOOD_FLAGS).map(([k, v]) => `--${k}=${v}`)];

/** Run validate with GOOD_FLAGS overridden by `over` (undefined removes a flag). */
function call(over: Record<string, string | undefined> = {}, extra: string[] = []) {
  const flags = { ...GOOD_FLAGS, ...over };
  const args = Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}=${v}`]));
  return main(["validate", ...args, ...extra], {}, p.dir);
}

describe("colab-comfy validate", () => {
  test("ok: exit 0, one summary line", async () => {
    const r = await call();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ok: s1a dense 704x1280 107f, 1 ref(s), 1 candidate(s)");
    expect(r.stderr).toBe("");
  });

  test("--json summary", async () => {
    const r = await call({ sparsity: "0.75" }, ["--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, node: "s1a", variant: "vsa-0.75", frames: 107, width: 704, height: 1280, refs: 1 });
  });

  test("sparsity 0 as the string filmkit passes it", async () => expect((await call({ sparsity: "0" })).exitCode).toBe(0));

  test("png + jpeg + webp refs are accepted", async () => {
    const r = await call({ prompt: "<Picture 1> <Picture 2> <Picture 3>", ref2: "./refs/b.jpg", ref3: "./refs/c.webp" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("3 ref(s)");
  });

  test("missing pick with candidates > 1 is fine (plan must work before candidates exist)", async () => {
    expect((await call({ candidates: "3" })).exitCode).toBe(0);
  });

  const failures: [string, Record<string, string | undefined>, string][] = [
    ["missing ref file", { ref: "./refs/nope.png" }, "ref"],
    ["ref is not an image", { ref: "./refs/doc.txt" }, "ref"],
    ["<Picture 2> with one ref", { prompt: "<Picture 2> talks" }, "prompt"],
    ["pick >= candidates", { candidates: "2", pick: "2" }, "pick"],
    ["frames x pixels cap", { resolution: "1344x768", duration: "6" }, "resolution"],
    ["--out not .mp4", { out: "./x.mov" }, "out"],
    ["--record not .json", { record: "./x.yaml" }, "record"],
    ["--record missing", { record: undefined }, "record"],
    ["bad resolution", { resolution: "640x360" }, "resolution"],
    ["bad sparsity", { sparsity: "0.6" }, "sparsity"],
    ["non-numeric seed", { seed: "abc" }, "seed"],
    ["unknown template", { template: "nope@1" }, "template"],
  ];
  for (const [name, over, field] of failures) {
    test(`exit 2 with field "${field}": ${name}`, async () => {
      const r = await call(over);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`error: ${field}:`);
      expect(r.stdout).toBe("");
    });
  }

  test("--json errors are {errors:[{code,message,field}]} on stderr, nothing on stdout", async () => {
    const r = await call({ ref: "./refs/nope.png" }, ["--json"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr) as { errors: { code: string; message: string; field?: string }[] };
    expect(err.errors[0]).toMatchObject({ code: "invalid-input", field: "ref" });
  });

  test("unknown flag and unknown command exit 2", async () => {
    expect((await main(["validate", "--bogus"], {}, p.dir)).exitCode).toBe(2);
    expect((await main(["frobnicate"], {}, p.dir)).exitCode).toBe(2);
  });

  test("materialize with no job flags is invalid input (exit 2), never silently ok", async () => {
    expect((await main(["materialize"], {}, p.dir)).exitCode).toBe(2);
  });

  test("the real executable: exit code and stdout through a subprocess", async () => {
    const bin = join(import.meta.dir, "..", "bin", "colab-comfy.ts");
    const proc = Bun.spawn([bin, ...GOOD], { cwd: p.dir, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("ok: s1a dense 704x1280 107f");
    const bad = Bun.spawn([bin, ...GOOD, "--sparsity=0.1"], { cwd: p.dir, stdout: "pipe", stderr: "pipe" });
    expect(await bad.exited).toBe(2);
  });
});
