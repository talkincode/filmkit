// `colab-comfy doctor` (the Profile's healthcheck) and `colab-comfy cache ls|prune` (PLAN M7).
// Fake colab shim only; no network, no money.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachePaths } from "../src/cache.ts";
import { main } from "../src/cli.ts";
import { Colab } from "../src/colab.ts";
import { doctor } from "../src/doctor.ts";
import { activePath, stateDir } from "../src/ledger.ts";
import { fakeColabEnv } from "./fake-colab.ts";
import { tmpProject } from "./support.ts";

const KEY = (c: string) => c.repeat(64);

describe("doctor", () => {
  test("shim: ready, every check ok, no session opened", async () => {
    const p = tmpProject();
    try {
      const env = fakeColabEnv(join(p.dir, "fake"));
      const r = await main(["doctor", "--json"], env, p.dir);
      expect(r.exitCode).toBe(0);
      const rep = JSON.parse(r.stdout);
      expect(rep.ready).toBe(true);
      expect(rep.checks.map((c: any) => [c.name, c.ok])).toEqual([["colab-on-path", true], ["colab-version", true], ["colab-auth", true], ["templates", true]]);
      expect(await new Colab({ env }).sessions()).toEqual([]);
    } finally {
      p.cleanup();
    }
  });

  test("a leftover fk-* session is a warning, not a failure", async () => {
    const p = tmpProject();
    try {
      const env = fakeColabEnv(join(p.dir, "fake"));
      const c = new Colab({ env });
      expect((await c.newSession("fk-leftover", "L4")).ok).toBe(true);
      const rep = await doctor(env);
      expect(rep.ready).toBe(true);
      expect(rep.checks.find((x) => x.name === "leftover-sessions")).toMatchObject({ ok: true, warning: true });
      await c.stop("fk-leftover");
    } finally {
      p.cleanup();
    }
  });

  test("no colab on PATH: not ready, exit 3, and nothing else is probed", async () => {
    const p = tmpProject();
    try {
      const r = await main(["doctor", "--json"], { PATH: join(p.dir, "empty") }, p.dir);
      expect(r.exitCode).toBe(3);
      const rep = JSON.parse(r.stdout);
      expect(rep.ready).toBe(false);
      expect(rep.checks.find((c: any) => c.name === "colab-on-path").ok).toBe(false);
      expect(rep.checks.some((c: any) => c.name === "colab-auth")).toBe(false);
    } finally {
      p.cleanup();
    }
  });

  test("auth probe failure (`colab sessions` fails): not ready, the failing check says so", async () => {
    const p = tmpProject();
    try {
      const bin = join(p.dir, "bin");
      mkdirSync(bin);
      const script = join(bin, "colab");
      writeFileSync(script, '#!/bin/sh\nfor a in "$@"; do [ "$a" = version ] && { echo "colab 0.7.4"; exit 0; }; done\necho "401 unauthenticated" >&2\nexit 1\n');
      chmodSync(script, 0o755);
      const rep = await doctor({ PATH: bin });
      expect(rep.ready).toBe(false);
      expect(rep.checks.find((c) => c.name === "colab-auth")).toMatchObject({ ok: false });
      expect(rep.checks.find((c) => c.name === "colab-version")).toMatchObject({ ok: true });
    } finally {
      p.cleanup();
    }
  });
});

// ----------------------------------------------------------------------------------------------------------
function seed(p: ReturnType<typeof tmpProject>, key: string, node: string, candidate: number, complete = true) {
  const paths = cachePaths(p.dir, key);
  mkdirSync(paths.dir, { recursive: true });
  if (complete) {
    writeFileSync(paths.clip, "x".repeat(2048));
    writeFileSync(paths.meta, JSON.stringify({ key, node, candidate, seed: 100 + candidate, session: "fk-t", downloadedAt: "2026-10-18T00:00:00Z", video: { sha256: "0".repeat(64), bytes: 2048 } }));
  } else {
    writeFileSync(`${paths.clip}.part`, "partial");
  }
}

/** Film dir with: A = winner of s1's record (referenced via the lock), B = losing candidate, C = incomplete leftover. */
function project() {
  const p = tmpProject();
  p.write("filmkit.yaml", "apiVersion: filmkit/v1alpha1\nkind: Film\nmetadata:\n  name: cache-test\n");
  seed(p, KEY("a"), "s1", 0);
  seed(p, KEY("b"), "s1", 1);
  seed(p, KEY("c"), "s2", 0, false);
  p.write("build/s1.colab.json", JSON.stringify({ schema: "colab-comfy/run-record@1", winner: { index: 0, cacheKey: KEY("a") } }));
  p.write("filmkit.lock.yaml", "version: 1\nnodes:\n  s1:\n    kind: scene\n    produces:\n      video: { path: ./build/s1.mp4, sha256: abc }\n      file: { path: ./build/s1.colab.json, sha256: def }\n");
  return p;
}

describe("cache ls / prune", () => {
  test("ls lists entries with node/candidate/seed/size and what references them", async () => {
    const p = project();
    try {
      const r = await main(["cache", "ls", "--json"], {}, p.dir);
      expect(r.exitCode).toBe(0);
      const e = JSON.parse(r.stdout).entries as any[];
      expect(e.map((x) => [x.key[0], x.complete, x.node, x.candidate, x.referencedBy])).toEqual([
        ["a", true, "s1", 0, ["s1"]],
        ["b", true, "s1", 1, []],
        ["c", false, null, null, []],
      ]);
      expect(e[0].bytes).toBeGreaterThan(2048);
      const text = await main(["cache", "ls"], {}, p.dir);
      expect(text.stdout).toContain("referenced by s1");
      expect(text.stdout).toContain("INCOMPLETE");
    } finally {
      p.cleanup();
    }
  });

  test("prune --keep-referenced removes the losing candidate and the incomplete leftover, keeps the winner; --dry-run changes nothing", async () => {
    const p = project();
    try {
      const dry = await main(["cache", "prune", "--keep-referenced", "--dry-run", "--json"], {}, p.dir);
      expect(JSON.parse(dry.stdout).removed).toHaveLength(2);
      expect(existsSync(cachePaths(p.dir, KEY("b")).dir)).toBe(true);

      const r = await main(["cache", "prune", "--keep-referenced", "--json"], {}, p.dir);
      expect(r.exitCode).toBe(0);
      const rep = JSON.parse(r.stdout);
      expect(rep.removed.map((x: any) => x.key[0]).sort()).toEqual(["b", "c"]);
      expect(rep.kept.map((x: any) => x.key[0])).toEqual(["a"]);
      expect(existsSync(cachePaths(p.dir, KEY("a")).clip)).toBe(true);
      expect(existsSync(cachePaths(p.dir, KEY("b")).dir)).toBe(false);
      expect(existsSync(cachePaths(p.dir, KEY("c")).dir)).toBe(false);
    } finally {
      p.cleanup();
    }
  });

  test("bare prune refuses (exit 5) without --yes and deletes nothing; --yes deletes everything", async () => {
    const p = project();
    try {
      const refused = await main(["cache", "prune"], {}, p.dir);
      expect(refused.exitCode).toBe(5);
      expect(refused.stderr).toContain("--keep-referenced");
      expect(existsSync(cachePaths(p.dir, KEY("a")).clip)).toBe(true);
      const ok = await main(["cache", "prune", "--yes"], {}, p.dir);
      expect(ok.exitCode).toBe(0);
      expect(existsSync(cachePaths(p.dir, KEY("a")).dir)).toBe(false);
    } finally {
      p.cleanup();
    }
  });

  test("prune is refused while a session may be alive (active.json); an unreadable lock deletes nothing", async () => {
    const p = project();
    try {
      mkdirSync(stateDir(p.dir), { recursive: true });
      writeFileSync(activePath(stateDir(p.dir)), "{}");
      const busy = await main(["cache", "prune", "--keep-referenced"], {}, p.dir);
      expect(busy.exitCode).toBe(2);
      expect(existsSync(cachePaths(p.dir, KEY("b")).dir)).toBe(true);
      p.write("filmkit.lock.yaml", "nodes: [unclosed\n");
      const bad = await main(["cache", "ls"], {}, p.dir);
      expect(bad.exitCode).toBe(1);
    } finally {
      p.cleanup();
    }
  });

  test("empty / missing cache and a bad subcommand", async () => {
    const p = tmpProject();
    try {
      expect((await main(["cache", "ls"], {}, p.dir)).stdout).toContain("cache is empty");
      expect((await main(["cache", "prune", "--keep-referenced"], {}, p.dir)).exitCode).toBe(0);
      expect((await main(["cache"], {}, p.dir)).exitCode).toBe(2);
      expect((await main(["cache", "wipe"], {}, p.dir)).exitCode).toBe(2);
    } finally {
      p.cleanup();
    }
  });
});
