// filmkit-level E2E for the colab-comfy profile (PLAN §8.2, E1-E9): the REAL filmkit (`bun bin/filmkit.ts`:
// validate / plan / run / status / build / doctor) on a temp project, the real helper (`colab-comfy` on PATH),
// the fake `colab` shim, the real VM scripts (FK_FAKE_SETUP=1) and a mock ComfyUI that returns real mp4s.
// No real `colab`, no network, no money. Style of tests/remotion.test.ts, scaffolding from tests/helpers.ts.
//
// Every test that touches Colab ends with the shim's `sessions` empty: spending is only ever through a session
// that was stopped and verified (the lifecycle itself is tested in tools/colab-comfy/test/lifecycle.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { sha256Hex } from "../tools/colab-comfy/src/canonical.ts";
import { Colab } from "../tools/colab-comfy/src/colab.ts";
import { readActive, readLedger, stateDir } from "../tools/colab-comfy/src/ledger.ts";
import { fakeColabEnv, readCalls } from "../tools/colab-comfy/test/fake-colab.ts";
import { startMockComfy, type MockComfy, type MockMode } from "../tools/colab-comfy/test/mock-comfy.ts";
import { media, project, type Project } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const FILMKIT_BIN = join(REPO, "bin/filmkit.ts");
const CLI = join(REPO, "tools/colab-comfy/bin/colab-comfy.ts");
const PROFILE = readFileSync(join(REPO, "profiles/colab-comfy.yaml"), "utf8");
const RECORD_SCHEMA = JSON.parse(readFileSync(join(REPO, "tools/colab-comfy/schema/run-record.schema.json"), "utf8"));
const validateRecord = new Ajv2020({ allErrors: true, strict: true }).compile(RECORD_SCHEMA);

const hasPython = Bun.which("python3") !== null;
if (!hasPython) console.warn("SKIP tests/colab-comfy.test.ts: python3 not found on PATH");
const d = hasPython ? describe : describe.skip;

// ---- scaffolding ------------------------------------------------------------------------------------------

let scratch = "";
let wrapperDir = "";
let sampleClip = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "filmkit-colab-e2e-"));
  // `colab-comfy` on PATH: the Profile's binary (invocation and validate run it by name).
  wrapperDir = join(scratch, "bin");
  mkdirSync(wrapperDir);
  writeFileSync(join(wrapperDir, "colab-comfy"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(wrapperDir, "colab-comfy"), 0o755);
  // What the mock ComfyUI "generates": 6 s of real video+audio (longer than every scene, so `exact` trims).
  sampleClip = join(scratch, "sample.mp4");
  media.mp4(sampleClip, 6, { w: 64, h: 64, audio: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Scene {
  id: string;
  ref: string;
  seed: number;
  duration: number;
  sparsity: number;
  prompt: string;
  extra?: string;
}

const defaultScenes = (): Scene[] => [
  { id: "s1a", ref: "ff_yM", seed: 20261017, duration: 2, sparsity: 0, prompt: "The woman from <Picture 1> stands on a yacht deck and speaks to the camera." },
  { id: "s3a", ref: "ff_bM", seed: 20261017, duration: 2.5, sparsity: 0.75, prompt: "The woman from <Picture 1> stands in shallow water and speaks to the camera." },
  { id: "s4a", ref: "ff_bC", seed: 20261017, duration: 2, sparsity: 0.5, prompt: "Close-up of the woman from <Picture 1> speaking to the camera." },
];

function filmYaml(scenes: Scene[]): string {
  const body = scenes
    .map(
      (s) => `  - id: ${s.id}
    duration: ${s.duration}
    durationPolicy: exact
    impl:
      profile: colab-comfy
      task: h3-ref2va
      params:
        template: h3-ref2va@1
        prompt: ${JSON.stringify(s.prompt)}
        ref: ./refs/${s.ref}.png
        seed: ${s.seed}
        duration: ${s.duration}
        resolution: 704x1280
        sparsity: ${s.sparsity}${s.extra ? `\n${s.extra}` : ""}
    produces: { video: ./build/h3/${s.id}.mp4, file: ./build/h3/${s.id}.colab.json }`,
    )
    .join("\n");
  return `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: e2e-h3 }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/colab-comfy.yaml
output:
  container: mp4
  video: { width: 176, height: 320, fps: 24, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
${body}
`;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

interface World {
  p: Project;
  scenes: Scene[];
  state: string;
  mock: MockComfy;
  env: Record<string, string>;
  /** Rewrite filmkit.yaml from `scenes`. */
  writeFilm(): void;
  /** Real filmkit, real subprocess, cwd = project. */
  fk(...args: string[]): Promise<Run>;
  /** The helper CLI as a subprocess. */
  cc(...args: string[]): Promise<Run>;
  calls(): string[];
  news(): number;
  lock(): string | null;
  lockNodes(): Record<string, any>;
  record(id: string): any;
  sessions(): Promise<string[]>;
  cacheClips(): number;
}

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) cleanup(w);
});

function cleanup(w: World): void {
  const rec = readActive(stateDir(w.p.dir));
  if (rec?.guardPid) {
    try {
      process.kill(rec.guardPid, "SIGKILL");
    } catch {}
  }
  const sess = join(w.state, "sessions");
  if (existsSync(sess)) {
    for (const s of readdirSync(sess)) {
      try {
        process.kill(Number(readFileSync(join(sess, s, "content", "fk", "runner.pid"), "utf8")), "SIGKILL");
      } catch {}
    }
  }
  w.mock.stop();
  w.p.cleanup();
}

async function sh(argv: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    try {
      json = JSON.parse(stderr);
    } catch {}
  }
  return { code, stdout, stderr, json };
}

/** `shared`: the caller owns the cleanup (a describe that keeps one project across tests). */
function world(o: { scenes?: Scene[]; mode?: MockMode | MockMode[]; shared?: boolean } = {}): World {
  const p = project();
  const state = join(p.dir, "fake-state");
  const scenes = o.scenes ?? defaultScenes();
  p.write("profiles/colab-comfy.yaml", PROFILE);
  scenes.forEach((s, i) => media.png(p.path(`refs/${s.ref}.png`), 64, 36, ["0x336699", "0x993366", "0x669933", "0xcc9933"][i % 4]));
  const mock = startMockComfy({ outputDir: join(p.dir, "comfy-out"), mode: o.mode, sampleMp4: sampleClip });
  const env = fakeColabEnv(
    state,
    {
      FAKE_COLAB_CU_PER_SEC: "0.02",
      PYTHONDONTWRITEBYTECODE: "1",
      FK_FAKE_SETUP: "1",
      FK_COMFY_URL: mock.url,
      FK_COMFY_INPUT_DIR: join(p.dir, "comfy-in"),
      FK_COMFY_OUTPUT_DIR: join(p.dir, "comfy-out"),
      FK_POLL_SEC: "0.05",
      FK_STATUS_EVERY: "0.3",
      FK_WATCHDOG_TICK: "0.2",
      FK_COMFY_DEAD_SEC: "1",
      COLAB_COMFY_POLL_SEC: "0.2",
      COLAB_COMFY_GUARD_TICK_MS: "200",
      COLAB_COMFY_BACKOFF_MS: "50",
      COLAB_COMFY_QUIET: "1",
      COLAB_COMFY_USAGE_SEC: "100000",
      COLAB_COMFY_FILMKIT: `${process.execPath} ${FILMKIT_BIN}`,
    },
    { ...process.env, PATH: `${wrapperDir}:${process.env.PATH ?? ""}` },
  );
  const w: World = {
    p,
    scenes,
    state,
    mock,
    env,
    writeFilm: () => p.write("filmkit.yaml", filmYaml(w.scenes)),
    fk: (...args) => sh([process.execPath, FILMKIT_BIN, ...args], p.dir, env),
    cc: (...args) => sh([process.execPath, CLI, ...args], p.dir, env),
    calls: () => readCalls(state).map((c) => c.sub),
    news: () => readCalls(state).filter((c) => c.sub === "new").length,
    lock: () => (existsSync(p.path("filmkit.lock.yaml")) ? readFileSync(p.path("filmkit.lock.yaml"), "utf8") : null),
    lockNodes: () => (w.lock() ? (parseYaml(w.lock()!) as { nodes: Record<string, any> }).nodes : {}),
    record: (id) => JSON.parse(readFileSync(p.path(`build/h3/${id}.colab.json`), "utf8")),
    sessions: async () => (await new Colab({ env }).sessions()).map((s) => s.name),
    cacheClips() {
      const root = p.path(".colab-comfy/cache");
      if (!existsSync(root)) return 0;
      return readdirSync(root).reduce((n, k2) => n + readdirSync(join(root, k2)).filter((k) => existsSync(join(root, k2, k, "clip.mp4"))).length, 0);
    },
  };
  w.writeFilm();
  if (!o.shared) worlds.push(w);
  return w;
}

const sha = (path: string) => sha256Hex(readFileSync(path));
const leftovers = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "fake-state" || e.name === "comfy-out" || e.name === "comfy-in") continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".part")) out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out;
};

const T = 180_000; // generous: the machine running these is often loaded by other work

// ------------------------------------------------------------------------------------------------------------
d("colab-comfy through real filmkit: one project, spend in two steps", () => {
  let w: World;
  let lockAfterFirst: string | null = null;
  let afterFull: { video: Record<string, string>; record: Record<string, string>; lock: string | null } | null = null;

  beforeAll(() => {
    w = world({ shared: true });
  });
  afterAll(() => cleanup(w));

  test("E1 validate + plan: the Profile's validate is delegated; plan lists the three nodes for `filmkit run`", async () => {
    const v = await w.fk("validate", "--json");
    expect(v.code).toBe(0);
    expect(v.json).toMatchObject({ ok: true, nodes: 3 });

    // the delegated validate really ran: a prompt that mentions a picture that does not exist is refused by the helper
    const good = w.scenes[0]!.prompt;
    w.scenes[0]!.prompt = "She is in <Picture 2> only.";
    w.writeFilm();
    const bad = await w.fk("validate", "--json");
    expect(bad.code).toBe(2);
    expect(JSON.stringify(bad.json)).toContain("<Picture 2>");
    w.scenes[0]!.prompt = good;
    w.writeFilm();

    const plan = await w.fk("plan", "--json");
    expect(plan.code).toBe(0);
    expect(plan.json.nodes.map((n: any) => [n.id, n.status, n.executor])).toEqual([
      ["s1a", "missing", "filmkit run"],
      ["s3a", "missing", "filmkit run"],
      ["s4a", "missing", "filmkit run"],
    ]);
    expect(w.calls()).toEqual([]); // validate/plan never touch colab
  }, T);

  test("E3a batch --nodes s1a (one job: no --yes needed) generates and materializes through filmkit run", async () => {
    const r = await w.cc("batch", "--nodes", "s1a", "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.session).toMatchObject({ outcome: "ok", jobsOk: 1 });
    expect(r.json.materialize.nodes).toEqual([{ id: "s1a", status: "materialized" }]);
    expect(w.news()).toBe(1);
    expect(await w.sessions()).toEqual([]);
    expect(existsSync(w.p.path("build/h3/s1a.mp4"))).toBe(true);
    expect(Object.keys(w.lockNodes())).toEqual(["s1a"]);
    lockAfterFirst = w.lock();
  }, T);

  test("E2 spend refused via `filmkit run`: s3a has no clip -> exit 2 (helper 5 -> invalid-input); no produce files; lock byte-identical; no colab call", async () => {
    const callsBefore = w.calls().length;
    const r = await w.fk("run", "s3a", "--json");
    expect(r.code).toBe(2);
    expect(JSON.stringify(r.json)).toContain("COLAB_COMFY_YES=1 filmkit run s3a");
    expect(JSON.stringify(r.json)).toMatch(/≈0\.\d\d CU for 1 job/);
    expect(existsSync(w.p.path("build/h3/s3a.mp4"))).toBe(false);
    expect(existsSync(w.p.path("build/h3/s3a.colab.json"))).toBe(false);
    expect(leftovers(w.p.dir)).toEqual([]);
    expect(w.lock()).toBe(lockAfterFirst);
    expect(w.calls()).toHaveLength(callsBefore);
  }, T);

  test("E3 batch --yes: only the 2 pending nodes are generated (ready s1a is never re-spent); status all ready; lock pins the record; build --draft works", async () => {
    const prompts = w.mock.prompts.length;
    const r = await w.cc("batch", "--yes", "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.nodes.map((n: any) => n.id)).toEqual(["s3a", "s4a"]);
    expect(r.json.session).toMatchObject({ outcome: "ok", jobsOk: 2, stop: { verified: true } });
    expect(w.mock.prompts.length - prompts).toBe(2);
    expect(w.news()).toBe(2); // one session for s1a, one for the other two
    expect(await w.sessions()).toEqual([]);
    expect(r.json.materialize.nodes.map((n: any) => [n.id, n.status])).toEqual([["s3a", "materialized"], ["s4a", "materialized"]]);

    const st = await w.fk("status", "--json");
    expect(st.code).toBe(0);
    expect(st.json.nodes.map((n: any) => [n.id, n.status])).toEqual([["s1a", "ready"], ["s3a", "ready"], ["s4a", "ready"]]);

    // the lock pins both the video and the run record by sha256 (no schema change in core)
    const nodes = w.lockNodes();
    for (const id of ["s1a", "s3a", "s4a"]) {
      expect(nodes[id].produces.file.sha256).toBe(sha(w.p.path(`build/h3/${id}.colab.json`)));
      expect(nodes[id].produces.video.sha256).toBe(sha(w.p.path(`build/h3/${id}.mp4`)));
      expect(nodes[id].produces.video.probe).toMatchObject({ hasAudio: true });
      const rec = w.record(id);
      expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
      expect(rec).toMatchObject({ node: id, stop: { stopped: true, sessionsVerifiedEmpty: true }, runtime: { provider: "colab" } });
    }
    expect(w.record("s3a").template.variant).toBe("vsa");
    expect(w.record("s1a").template.variant).toBe("dense");
    expect(w.record("s3a").params).toMatchObject({ sparsity: 0.75, candidates: 1, pick: null });

    // CU attribution: the second session's two clips share its actual CU
    const ledger = readLedger(stateDir(w.p.dir));
    expect(ledger).toHaveLength(2);
    const last = ledger[1]!;
    const a = w.record("s3a").cost;
    const b = w.record("s4a").cost;
    expect(a.session).toBe(last.session as string);
    expect(a.sessionActualCU).toBe(last.actualCU as number);
    expect(a.attributedCU + b.attributedCU).toBeCloseTo(last.actualCU as number, 2);
    expect(a.estimateCU).toBeCloseTo(last.estimateCU as number, 6);

    const build = await w.fk("build", "--draft", "--json");
    expect(build.code, build.stderr).toBe(0);
    expect(existsSync(w.p.path("build/film.mp4")) || readdirSync(w.p.path("build")).some((f) => f.endsWith(".mp4"))).toBe(true);
    afterFull = {
      video: Object.fromEntries(["s1a", "s3a", "s4a"].map((id) => [id, sha(w.p.path(`build/h3/${id}.mp4`))])),
      record: Object.fromEntries(["s1a", "s3a", "s4a"].map((id) => [id, sha(w.p.path(`build/h3/${id}.colab.json`))])),
      lock: w.lock(),
    };
  }, T);

  test("E4 re-runs are free: filmkit run s1a again and a second batch open no session; produce + record bytes unchanged", async () => {
    const newsBefore = w.news();
    const callsBefore = w.calls().length;
    const run = await w.fk("run", "s1a", "--json");
    expect(run.code, run.stderr).toBe(0);
    expect(sha(w.p.path("build/h3/s1a.mp4"))).toBe(afterFull!.video.s1a!);
    expect(sha(w.p.path("build/h3/s1a.colab.json"))).toBe(afterFull!.record.s1a!);
    expect(w.lock()).toBe(afterFull!.lock);

    const batch = await w.cc("batch", "--json");
    expect(batch.code, batch.stderr).toBe(0);
    expect(batch.json.jobsToGenerate).toBe(0);
    expect(batch.json.session).toBeNull();
    expect(w.news()).toBe(newsBefore);
    expect(w.calls()).toHaveLength(callsBefore);
  }, T);

  test("E5 prompt change: only s3a goes stale; batch generates exactly 1 job and s3a is ready again", async () => {
    w.scenes[1]!.prompt = "The woman from <Picture 1> waves at the camera from a beach.";
    w.writeFilm();
    const plan = await w.fk("plan", "--json");
    expect(plan.json.nodes.map((n: any) => [n.id, n.status])).toEqual([["s3a", "stale"]]);

    const prompts = w.mock.prompts.length;
    const newsBefore = w.news();
    const r = await w.cc("batch", "--json"); // one job: no --yes needed
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.nodes.map((n: any) => n.id)).toEqual(["s3a"]);
    expect(w.mock.prompts.length - prompts).toBe(1);
    expect(w.news() - newsBefore).toBe(1);
    expect(await w.sessions()).toEqual([]);
    const st = await w.fk("status", "--json");
    expect(st.json.nodes.map((n: any) => n.status)).toEqual(["ready", "ready", "ready"]);
    // the other two nodes' produces did not change
    expect(sha(w.p.path("build/h3/s1a.colab.json"))).toBe(afterFull!.record.s1a!);
    expect(sha(w.p.path("build/h3/s4a.colab.json"))).toBe(afterFull!.record.s4a!);
    expect(sha(w.p.path("build/h3/s3a.colab.json"))).not.toBe(afterFull!.record.s3a!);
  }, T);
});

// ------------------------------------------------------------------------------------------------------------
d("candidates", () => {
  test("E6 candidates: 2 without pick -> batch renders both, reports needs-pick, node not ready; pick: 1 -> filmkit run materializes seed+1 with 0 new colab calls", async () => {
    const w = world({ scenes: [{ ...defaultScenes()[0]!, extra: "        candidates: 2" }] });
    const r = await w.cc("batch", "--yes", "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.session).toMatchObject({ outcome: "ok", jobsOk: 2 });
    expect(w.mock.prompts).toHaveLength(2);
    expect(w.cacheClips()).toBe(2);
    const node = r.json.materialize.nodes[0];
    expect(node).toMatchObject({ id: "s1a", status: "needs-pick" });
    expect(node.candidates.map((c: any) => [c.index, c.seed, c.cached])).toEqual([[0, 20261017, true], [1, 20261018, true]]);
    for (const c of node.candidates) expect(existsSync(w.p.path(c.cachePath))).toBe(true);
    // no pick -> filmkit never ran, the node is not ready, nothing was written
    expect(existsSync(w.p.path("build/h3/s1a.mp4"))).toBe(false);
    expect(w.lock()).toBeNull();
    const st = await w.fk("status", "--json");
    expect(st.json.nodes[0].status).toBe("missing");
    // `filmkit run` without a pick is refused with the candidate paths, and spends nothing
    const refused = await w.fk("run", "s1a", "--json");
    expect(refused.code).toBe(2);
    expect(JSON.stringify(refused.json)).toContain(node.candidates[1].cachePath);
    expect(await w.sessions()).toEqual([]);

    // the human/agent reviews and writes the pick
    const newsBefore = w.news();
    w.scenes[0]!.extra = "        candidates: 2\n        pick: 1";
    w.writeFilm();
    const run = await w.fk("run", "s1a", "--json");
    expect(run.code, run.stderr).toBe(0);
    expect(w.news()).toBe(newsBefore); // 0 CU
    expect(w.mock.prompts).toHaveLength(2);
    const rec = w.record("s1a");
    expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
    expect(rec.winner).toMatchObject({ index: 1, seed: 20261018, selectedBy: "params.pick" });
    expect(rec.candidates.map((c: any) => [c.index, c.seed])).toEqual([[0, 20261017], [1, 20261018]]);
    expect(rec.winner.cacheKey).toBe(node.candidates[1].cachePath.split("/")[3]);
    expect(rec.params).toMatchObject({ candidates: 2, pick: 1 });
    expect((await w.fk("status", "--json")).json.nodes[0].status).toBe("ready");
  }, T);
});

// ------------------------------------------------------------------------------------------------------------
d("failures", () => {
  test("E7 one job fails: that node stays missing (no produces, no .part, not in the lock); the others are ready; exit 4; session stopped", async () => {
    const w = world({ mode: ["ok", "oom", "ok"] });
    const r = await w.cc("batch", "--yes", "--json");
    expect(r.code).toBe(4);
    expect(r.json.session).toMatchObject({ outcome: "partial", jobsOk: 2 });
    expect(r.json.materialize.nodes.map((n: any) => [n.id, n.status])).toEqual([["s1a", "materialized"], ["s3a", "not-generated"], ["s4a", "materialized"]]);
    expect(await w.sessions()).toEqual([]);
    expect(w.mock.prompts).toHaveLength(3); // never retried

    expect(existsSync(w.p.path("build/h3/s3a.mp4"))).toBe(false);
    expect(existsSync(w.p.path("build/h3/s3a.colab.json"))).toBe(false);
    expect(leftovers(w.p.dir)).toEqual([]);
    expect(Object.keys(w.lockNodes())).toEqual(["s1a", "s4a"]);
    const st = await w.fk("status", "--json");
    expect(st.json.nodes.map((n: any) => [n.id, n.status])).toEqual([["s1a", "ready"], ["s3a", "missing"], ["s4a", "ready"]]);

    // asking filmkit to run the failed node is refused (cache miss), not silently re-spent
    // (`status` records not-ready nodes in the lock as missing, so compare around the refused run, not before status)
    const callsBefore = w.calls().length;
    const lockBefore = w.lock();
    const again = await w.fk("run", "s3a", "--json");
    expect(again.code).toBe(2);
    expect(w.calls()).toHaveLength(callsBefore);
    expect(w.lock()).toBe(lockBefore);
    expect(w.lockNodes().s3a?.status).not.toBe("ready");
  }, T);

  test("E8 missing ref: plan lists the file under missingFiles; validate does not delegate for that node; run and batch refuse without a colab call", async () => {
    const w = world();
    rmSync(w.p.path("refs/ff_yM.png"));
    // filmkit itself reports the missing file; the helper's validate was not run for s1a (it would add its own
    // "ref file not found" error: there is exactly one error, with the core's wording)
    const v = await w.fk("validate", "--json");
    expect(v.code).toBe(2);
    expect(v.json.errors).toHaveLength(1);
    expect(v.json.errors[0]).toMatchObject({ field: "scenes[0].impl.params.ref", message: expect.stringContaining("referenced file is not in place") });

    const plan = await w.fk("plan", "--json");
    expect(plan.code).toBe(0);
    expect(plan.json.missingFiles).toEqual([expect.objectContaining({ path: "./refs/ff_yM.png", usedBy: ["s1a"] })]);

    const run = await w.fk("run", "s1a", "--json");
    expect(run.code).toBe(2);
    expect(JSON.stringify(run.json)).toContain("referenced file is not in place");

    const batch = await w.cc("batch", "--yes", "--json");
    expect(batch.code).toBe(2);
    expect(JSON.stringify(batch.json)).toContain("s1a.ref");
    expect(w.calls()).toEqual([]);
    expect(w.lock()).toBeNull();
  }, T);
});

// ------------------------------------------------------------------------------------------------------------
d("spend authorization from filmkit run", () => {
  test("COLAB_COMFY_YES=1 filmkit run <id>: a batch of one under the same gate; produce + record written; session stopped; the next run is free", async () => {
    const w = world({ scenes: [defaultScenes()[0]!] });
    const refused = await w.fk("run", "s1a", "--json");
    expect(refused.code).toBe(2);
    expect(w.calls()).toEqual([]);

    const yes = await sh([process.execPath, FILMKIT_BIN, "run", "s1a", "--json"], w.p.dir, { ...w.env, COLAB_COMFY_YES: "1" });
    expect(yes.code, yes.stderr).toBe(0);
    expect(w.news()).toBe(1);
    expect(await w.sessions()).toEqual([]);
    expect(readLedger(stateDir(w.p.dir))).toHaveLength(1);
    const rec = w.record("s1a");
    expect(validateRecord(rec), JSON.stringify(validateRecord.errors)).toBe(true);
    expect(rec.cost.attributedCU).toBe(rec.cost.sessionActualCU); // the only job carries the whole session
    expect((await w.fk("status", "--json")).json.nodes[0].status).toBe("ready");

    const recSha = sha(w.p.path("build/h3/s1a.colab.json"));
    const again = await sh([process.execPath, FILMKIT_BIN, "run", "s1a", "--json"], w.p.dir, { ...w.env, COLAB_COMFY_YES: "1" });
    expect(again.code).toBe(0);
    expect(w.news()).toBe(1); // YES does not re-spend: the clip is cached
    expect(sha(w.p.path("build/h3/s1a.colab.json"))).toBe(recSha);
  }, T);

  test("COLAB_COMFY_YES=1 cannot raise the budget: over-budget -> exit 2 via filmkit, no session", async () => {
    const w = world({ scenes: [defaultScenes()[0]!] });
    const r = await sh([process.execPath, FILMKIT_BIN, "run", "s1a", "--json"], w.p.dir, { ...w.env, COLAB_COMFY_YES: "1", COLAB_COMFY_BUDGET_CU: "0.1" });
    expect(r.code).toBe(2);
    expect(JSON.stringify(r.json)).toContain("exceeds the budget");
    expect(w.calls()).toEqual([]);
    expect(existsSync(w.p.path("build/h3/s1a.mp4"))).toBe(false);
  }, T);
});

// ------------------------------------------------------------------------------------------------------------
describe("doctor", () => {
  test("E9 filmkit doctor with the shim: the profile is ok (healthcheck ran); without colab on PATH: exit 3", async () => {
    const w = world({ scenes: [defaultScenes()[0]!] });
    const ok = await w.fk("doctor", "--json");
    expect(ok.code, ok.stderr).toBe(0);
    const prof = ok.json.profiles.find((x: any) => x.name === "colab-comfy");
    expect(prof).toMatchObject({ ok: true, healthcheck: { ok: true, expect: { ok: true } } });
    expect(prof.binaries.map((b: any) => [b.name, b.found])).toEqual([["colab-comfy", true], ["colab", true]]);

    // A PATH that has ffmpeg/ffprobe and the helper, but no colab (a real one may be installed on this machine).
    const bare = join(w.p.dir, "bare-bin");
    mkdirSync(bare);
    for (const tool of ["ffmpeg", "ffprobe"]) symlinkSync(Bun.which(tool)!, join(bare, tool));
    symlinkSync(join(wrapperDir, "colab-comfy"), join(bare, "colab-comfy"));
    const missing = await sh([process.execPath, FILMKIT_BIN, "doctor", "--json"], w.p.dir, { ...w.env, PATH: bare });
    expect(missing.code).toBe(3);
    expect(missing.json.profiles.find((x: any) => x.name === "colab-comfy")).toMatchObject({ ok: false });
  }, T);
});
