import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "bun";
import { tarGz } from "../src/archive.ts";
import { sandbox } from "./fixtures.ts";

const box = sandbox();
afterAll(() => box.cleanup());
const enc = (s: string) => new TextEncoder().encode(s);

describe("source archive", () => {
  const entries = [
    { path: "source/b.txt", data: enc("bee") },
    { path: "source/a/z.bin", data: new Uint8Array(1000).fill(7) },
    { path: "source/a.txt", data: enc("") },
  ];

  test("same entries -> same bytes, whatever order they were given in", () => {
    const one = tarGz(entries);
    const two = tarGz([...entries].reverse());
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
    // no timestamps, no platform byte: header mtime is 0 and OS is Unix
    expect([...one.slice(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(one[9]).toBe(3);
  });

  test("is a valid tar.gz that the system tar extracts with the right bytes", () => {
    const file = box.path("a.tar.gz");
    writeFileSync(file, tarGz(entries));
    const out = box.path("x");
    mkdirSync(out);
    const r = spawnSync("tar", ["xzf", file, "-C", out]);
    expect(r.status).toBe(0);
    expect(readFileSync(`${out}/source/b.txt`, "utf8")).toBe("bee");
    expect(readFileSync(`${out}/source/a/z.bin`).every((b) => b === 7)).toBe(true);
    expect(readFileSync(`${out}/source/a.txt`).length).toBe(0);
    const listing = spawnSync("tar", ["tzf", file], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(listing).toEqual(["source/a.txt", "source/a/z.bin", "source/b.txt"]);
  });

  test("a path too long for ustar is refused loudly", () => {
    expect(() => tarGz([{ path: "x".repeat(101), data: enc("") }])).toThrow(/too long/);
    expect(gunzipSync(new Uint8Array(tarGz([]))).length).toBe(1024);
  });
});
