// Landing is all-or-nothing and never overwrites: the part of render that touches the user's directory.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkNoConflicts, land, targetsOf } from "../src/bundle.ts";
import { BlockoutError } from "../src/errors.ts";
import { sandbox, tree, type Sandbox } from "./fixtures.ts";

let box: Sandbox;
afterEach(() => box?.cleanup());

const names = targetsOf({ videoName: "reference.mp4", manifestName: "manifest.json" });

/** A staged bundle: every landing target, each containing its own name. */
function staged(root: string): string {
  const out = join(root, "stage");
  mkdirSync(join(out, "keyframes"), { recursive: true });
  for (const t of names) {
    if (t.dir) writeFileSync(join(out, t.name, "kf-0000.png"), `new ${t.name}`);
    else writeFileSync(join(out, t.name), `new ${t.name}`);
  }
  return out;
}

describe("no overwrite", () => {
  test("any existing target refuses before work starts (io, exit 1) and names the clash", () => {
    box = sandbox();
    writeFileSync(box.path("reference.mp4"), "mine");
    mkdirSync(box.path("keyframes"));
    writeFileSync(box.path("keyframes/kf-0000.png"), "mine too");
    let thrown: BlockoutError | undefined;
    try {
      checkNoConflicts({ dir: box.dir, videoName: "reference.mp4", manifestName: "manifest.json", force: false });
    } catch (e) {
      thrown = e as BlockoutError;
    }
    expect(thrown?.exitCode).toBe(1);
    expect(thrown?.details[0]!.message).toContain("reference.mp4");
    expect(thrown?.details[0]!.message).toContain("keyframes");
    expect(thrown?.details[0]!.hint).toContain("--force");
  });

  test("an empty keyframes directory (e.g. one the caller pre-created) is not a conflict", () => {
    box = sandbox();
    mkdirSync(box.path("keyframes"));
    expect(() => checkNoConflicts({ dir: box.dir, videoName: "reference.mp4", manifestName: "manifest.json", force: false })).not.toThrow();
  });
});

describe("land", () => {
  test("a clean destination receives everything, manifest last", () => {
    box = sandbox();
    const dest = box.path("dest");
    mkdirSync(dest);
    const order: string[] = [];
    land(dest, staged(box.dir), box.path("backup"), names, false, { afterLand: (n) => order.push(n) });
    expect(order).toEqual(["reference.mp4", "overview.png", "keyframes", "source.tar.gz", "manifest.json"]);
    expect(tree(dest)).toEqual(["keyframes", "keyframes/kf-0000.png", "manifest.json", "overview.png", "reference.mp4", "source.tar.gz"]);
  });

  test("a failure after some files landed removes them: the destination is as it was", () => {
    box = sandbox();
    const dest = box.path("dest");
    mkdirSync(dest);
    writeFileSync(join(dest, "notes.txt"), "unrelated");
    const before = tree(dest);
    let thrown: BlockoutError | undefined;
    try {
      land(dest, staged(box.dir), box.path("backup"), names, false, {
        afterLand: (_n, i) => {
          if (i === 2) throw new Error("disk full (simulated)");
        },
      });
    } catch (e) {
      thrown = e as BlockoutError;
    }
    expect(thrown?.exitCode).toBe(1);
    expect(thrown?.details[0]!.message).toContain("disk full (simulated)");
    expect(tree(dest)).toEqual(before);
    expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("unrelated");
  });

  test("--force replaces transactionally: a mid-way failure restores the old bundle byte for byte", () => {
    box = sandbox();
    const dest = box.path("dest");
    mkdirSync(join(dest, "keyframes"), { recursive: true });
    for (const t of names) {
      if (t.dir) writeFileSync(join(dest, t.name, "kf-9999.png"), "old kf");
      else writeFileSync(join(dest, t.name), `old ${t.name}`);
    }
    const before = tree(dest);
    expect(() =>
      land(dest, staged(box.dir), box.path("backup"), names, true, {
        afterLand: (_n, i) => {
          if (i === 3) throw new Error("boom");
        },
      }),
    ).toThrow(BlockoutError);
    expect(tree(dest)).toEqual(before);
    expect(readFileSync(join(dest, "reference.mp4"), "utf8")).toBe("old reference.mp4");
    expect(readFileSync(join(dest, "keyframes/kf-9999.png"), "utf8")).toBe("old kf");
    expect(readFileSync(join(dest, "manifest.json"), "utf8")).toBe("old manifest.json");
  });

  test("--force that succeeds swaps the whole bundle, including the keyframes directory", () => {
    box = sandbox();
    const dest = box.path("dest");
    mkdirSync(join(dest, "keyframes"), { recursive: true });
    writeFileSync(join(dest, "keyframes/kf-9999.png"), "stale still");
    writeFileSync(join(dest, "reference.mp4"), "old");
    land(dest, staged(box.dir), box.path("backup"), names, true);
    expect(readFileSync(join(dest, "reference.mp4"), "utf8")).toBe("new reference.mp4");
    expect(existsSync(join(dest, "keyframes/kf-9999.png"))).toBe(false);
    expect(existsSync(join(dest, "keyframes/kf-0000.png"))).toBe(true);
  });
});
