// Tests for `filmkit import`:
// - Verifies deprecation and explicit removal error for `hyperstory`
// - Verifies usage validation and unknown kind errors
// - Verifies `import script` happy path, output placement, and overwrite protection

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { media, project, type Project } from "./helpers.ts";

let p: Project;
beforeEach(() => (p = project()));
afterEach(() => p.cleanup());

describe("import deprecation and validation", () => {
  test("import hyperstory is explicitly rejected as deprecated and removed", () => {
    p.write("schema.json", JSON.stringify({ version: "1.0", scenes: [] }));
    const r = p.json("import", "hyperstory", "./schema.json");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.code).toBe("invalid-input");
    expect(r.err!.errors[0]!.message).toContain('import kind "hyperstory" is deprecated and removed');
    expect(r.err!.errors[0]!.hint).toContain("supported: script");
  });

  test("missing kind or source displays usage with script", () => {
    const r1 = p.json("import");
    expect(r1.exitCode).toBe(2);
    expect(r1.err!.errors[0]!.message).toBe("usage: filmkit import script <file> [--out filmkit.yaml]");

    const r2 = p.json("import", "script");
    expect(r2.exitCode).toBe(2);
    expect(r2.err!.errors[0]!.message).toBe("usage: filmkit import script <file> [--out filmkit.yaml]");
  });

  test("unknown import kind points to supported kinds", () => {
    p.write("test.txt", "content");
    const r = p.json("import", "unknown-kind", "./test.txt");
    expect(r.exitCode).toBe(2);
    expect(r.err!.errors[0]!.message).toBe('unknown import kind "unknown-kind"');
    expect(r.err!.errors[0]!.hint).toBe("supported: script");
  });
});

describe("import script integration", () => {
  const sampleScript = `# Product Overview

Intro text.

## Scene One

Narration for scene one.

![](images/scene1.png)

## Scene Two

Narration for scene two.
`;

  test("imports markdown script into a valid filmkit.yaml", () => {
    media.png(p.path("images/scene1.png"), 160, 90);
    p.write("notes.md", sampleScript);

    const r = p.json<{ out: string; scenes: number; missingFiles: string[]; warnings: string[] }>("import", "script", "./notes.md");
    expect(r.exitCode).toBe(0);
    expect(r.out!.scenes).toBe(2);
    expect(r.out!.missingFiles).toEqual(["./assets/scene-two.png"]);

    const filmYaml = readFileSync(p.path("filmkit.yaml"), "utf8");
    expect(filmYaml).toContain("kind: Film");
    expect(filmYaml).toContain('title: "Product Overview"');
    expect(filmYaml).toContain("scene-one");
    expect(filmYaml).toContain("scene-two");

    const plan = p.json<{ nodes: { id: string }[] }>("plan");
    expect(plan.exitCode).toBe(0);
  });

  test("refuses to overwrite without --force, supports --out", () => {
    p.write("notes.md", sampleScript);
    p.write("filmkit.yaml", "# pre-existing\n");

    const refused = p.json("import", "script", "./notes.md");
    expect(refused.exitCode).toBe(1);
    expect(refused.err!.errors[0]!.message).toMatch(/refusing to overwrite/);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe("# pre-existing\n");

    const forced = p.cli("import", "script", "./notes.md", "--force");
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toContain("kind: Film");

    const outCustom = p.cli("import", "script", "./notes.md", "--out", "custom/film.yaml");
    expect(outCustom.exitCode).toBe(0);
    expect(existsSync(p.path("custom/film.yaml"))).toBe(true);
  });
});
