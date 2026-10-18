// VM runner protocol (colab-comfy/v1): the real fk_*.py scripts run as real python3 subprocesses
// with FK_ROOT in a temp dir, against the mock ComfyUI. No `colab`, no network, no GPU.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSampleMp4, startMockComfy, type MockComfy, type MockMode } from "./mock-comfy.ts";
import { FAKE_PYLIB } from "./fake-colab.ts";
import { fakePng } from "./support.ts";

const VM = join(import.meta.dir, "..", "vm");
const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "..", "templates", "h3-ref2va@1", "manifest.json"), "utf8"));
const hasPython = Bun.which("python3") !== null;
if (!hasPython) console.warn("SKIP runner.test.ts: python3 not found on PATH");
const d = hasPython ? describe : describe.skip;

let sample = "";
let sampleDir = "";
beforeAll(async () => {
  if (!hasPython) return;
  sampleDir = mkdtempSync(join(tmpdir(), "colab-comfy-sample-"));
  sample = await makeSampleMp4(sampleDir);
});
afterAll(() => {
  if (sampleDir) rmSync(sampleDir, { recursive: true, force: true });
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  base: string;
  root: string;
  comfyOut: string;
  comfyIn: string;
  marker: string;
  mock: MockComfy;
  env: Record<string, string>;
  keys: string[];
  inputFile: string;
  run(script: string, extraEnv?: Record<string, string>): Promise<{ lines: string[]; status: any; stdout: string; stderr: string }>;
  status(): any;
  waitFor(pred: (s: any) => boolean, ms?: number): Promise<any>;
}

const live: Harness[] = [];

interface Opts {
  jobs?: number;
  mode?: MockMode | MockMode[];
  limits?: Record<string, unknown>;
  classes?: string[];
  requiredClasses?: string[];
  secrets?: string;
  bundleExtra?: (stage: string) => void;
  extraEnv?: Record<string, string>;
  noBundle?: boolean;
}

async function tar(args: string[]) {
  const p = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error("tar failed: " + (await new Response(p.stderr).text()));
}

async function harness(o: Opts = {}): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "colab-comfy-runner-"));
  const root = join(base, "fk");
  const comfyOut = join(base, "ComfyUI", "output");
  const comfyIn = join(base, "ComfyUI", "input");
  const marker = join(base, "released.json");
  mkdirSync(root, { recursive: true });
  mkdirSync(comfyOut, { recursive: true });
  const mock = startMockComfy({ outputDir: comfyOut, mode: o.mode, classes: o.classes, sampleMp4: sample });

  const png = fakePng("runner-test");
  const inputFile = `${sha(png)}.png`;
  const n = o.jobs ?? 2;
  const keys = Array.from({ length: n }, (_, i) => sha(`job-${i}`));
  const jobsDoc = {
    protocol: "colab-comfy/v1",
    session: "fk-test",
    manifest: MANIFEST,
    manifestSha256: sha(JSON.stringify(MANIFEST)),
    requiredClasses: o.requiredClasses ?? ["MiniMaxH3ReferenceToVideo", "SaveVideo"],
    limits: { setupTimeoutSec: 30, comfyStartTimeoutSec: 10, jobTimeoutSec: 30, idleTtlSec: 600, ...o.limits },
    jobs: keys.map((key, i) => ({
      key, node: `s${i}`, candidate: 0, seed: i, frames: 107, width: 64, height: 64, variant: "dense",
      inputs: [{ file: inputFile, sha256: sha(png) }],
      workflow: {
        "6": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: "p", width: 64, height: 64 } },
        "16": { class_type: "SaveVideo", inputs: { filename_prefix: "fk/out", video: ["15", 0] } },
      },
    })),
  };
  if (!o.noBundle) {
    const stage = join(base, "stage");
    mkdirSync(join(stage, "vm"), { recursive: true });
    mkdirSync(join(stage, "inputs"), { recursive: true });
    for (const f of readdirSync(VM)) if (f.endsWith(".py")) writeFileSync(join(stage, "vm", f), readFileSync(join(VM, f)));
    writeFileSync(join(stage, "jobs.json"), JSON.stringify(jobsDoc));
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(MANIFEST));
    writeFileSync(join(stage, "inputs", inputFile), png);
    if (o.secrets) writeFileSync(join(stage, "secrets.env"), o.secrets, { mode: 0o600 });
    o.bundleExtra?.(stage);
    await tar(["-C", stage, "-czf", join(root, "bundle.tar.gz"), "."]);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PYTHONDONTWRITEBYTECODE: "1", // keep __pycache__ out of the tracked vm/ dir
    FK_ROOT: root,
    FK_FAKE_SETUP: "1",
    FK_COMFY_URL: mock.url,
    FK_COMFY_INPUT_DIR: comfyIn,
    FK_COMFY_OUTPUT_DIR: comfyOut,
    FK_POLL_SEC: "0.05",
    FK_STATUS_EVERY: "0.5",
    FK_WATCHDOG_TICK: "0.1",
    FK_COMFY_DEAD_SEC: "1",
    FK_SELF_RELEASE_MARKER: marker,
    ...o.extraEnv,
  };
  const h: Harness = {
    base, root, comfyOut, comfyIn, marker, mock, env, keys, inputFile,
    async run(script, extraEnv) {
      const p = Bun.spawn(["python3", join(VM, script)], { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (stderr.trim() && !extraEnv) console.warn(`${script} stderr:`, stderr);
      const lines = stdout.split("\n").filter((l) => l.startsWith("FKSTATUS "));
      return { lines, status: lines[0] ? JSON.parse(lines[0].slice("FKSTATUS ".length)) : null, stdout, stderr };
    },
    status: () => JSON.parse(readFileSync(join(root, "status.json"), "utf8")),
    async waitFor(pred, ms = 15000) {
      const end = Date.now() + ms;
      let last: any = null;
      while (Date.now() < end) {
        try {
          last = h.status();
          if (pred(last)) return last;
        } catch {}
        await sleep(50);
      }
      throw new Error("timed out waiting; last status: " + JSON.stringify(last));
    },
  };
  live.push(h);
  return h;
}

afterEach(() => {
  for (const h of live.splice(0)) {
    try {
      process.kill(Number(readFileSync(join(h.root, "runner.pid"), "utf8")), "SIGKILL");
    } catch {}
    h.mock.stop();
    rmSync(h.base, { recursive: true, force: true });
  }
});

const terminal = (s: any) => ["done", "failed", "aborted"].includes(s.phase);

d("runner (colab-comfy/v1)", () => {
  test("success: 2 jobs -> 2 mp4 outputs with sha256, inputs copied, then idle TTL releases the VM", async () => {
    const h = await harness({ jobs: 2, limits: { idleTtlSec: 2 } });
    const kick = await h.run("fk_kick.py");
    expect(kick.status).toMatchObject({ ok: true, kicked: true });
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("done");
    expect(s.error).toBeNull();
    expect(s.env.gpu.name).toBe("FAKE GPU");
    for (const [i, key] of h.keys.entries()) {
      const job = s.jobs[i];
      expect(job.state).toBe("done");
      const out = join(h.root, "out", `${key}.mp4`);
      expect(job.output).toEqual({ path: out, bytes: readFileSync(out).length, sha256: sha(readFileSync(out)) });
      expect(readFileSync(out).length).toBeGreaterThan(1000); // the real ffmpeg clip, not a stub
      expect(job.wallSec).toBeGreaterThanOrEqual(0);
      expect(h.mock.prompts[i]["16"].inputs.filename_prefix).toBe(`fk/${key}`);
      expect(existsSync(join(h.comfyOut, "fk", `${key}_00001_.mp4`))).toBe(false); // moved, not copied
    }
    expect(sha(readFileSync(join(h.comfyIn, h.inputFile)))).toBe(sha(fakePng("runner-test")));
    // no host polls from now on -> phase stays done, watchdog records the reason and "releases"
    const end = Date.now() + 8000;
    while (!existsSync(h.marker) && Date.now() < end) await sleep(100);
    expect(JSON.parse(readFileSync(h.marker, "utf8")).reason).toBe("idle-ttl");
    expect(h.status().phase).toBe("done");
    expect(h.status().watchdog.reason).toBe("idle-ttl");
  }, 20000);

  test("OOM on one job: POST /free, continue with the next, phase done", async () => {
    const h = await harness({ jobs: 3, mode: ["ok", "oom", "ok"] });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("done");
    expect(s.jobs.map((j: any) => j.state)).toEqual(["done", "failed", "done"]);
    expect(s.jobs[1].error.kind).toBe("oom");
    expect(s.jobs[1].error.message).toContain("CUDA out of memory");
    expect(s.jobs[1].output).toBeNull();
    expect(h.mock.frees).toBe(1);
    expect(existsSync(join(h.root, "out", `${h.keys[1]}.mp4`))).toBe(false);
    expect(existsSync(join(h.root, "out", `${h.keys[2]}.mp4`))).toBe(true);
  }, 20000);

  test("generic ComfyUI failure: job failed (comfy), batch continues, no retry", async () => {
    const h = await harness({ jobs: 2, mode: ["fail", "ok"] });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("done");
    expect(s.jobs[0]).toMatchObject({ state: "failed", error: { kind: "comfy" } });
    expect(s.jobs[1].state).toBe("done");
    expect(h.mock.prompts.length).toBe(2); // exactly one submission per job
    expect(h.mock.frees).toBe(0);
  }, 20000);

  test("ComfyUI crash: running job and the rest fail, phase failed", async () => {
    const h = await harness({ jobs: 3, mode: ["ok", "crash"] });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("failed");
    expect(s.jobs.map((j: any) => j.state)).toEqual(["done", "failed", "failed"]);
    expect(s.jobs[1].error.kind).toBe("comfy");
    expect(s.jobs[2].error.message).toContain("ComfyUI");
    expect(s.error).toBeTruthy();
    expect(existsSync(join(h.root, "out", `${h.keys[0]}.mp4`))).toBe(true); // finished clips survive
  }, 20000);

  test("job timeout: POST /interrupt, job failed(timeout), next job still runs", async () => {
    const h = await harness({ jobs: 2, mode: ["hang", "ok"], limits: { jobTimeoutSec: 1 } });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("done");
    expect(s.jobs[0]).toMatchObject({ state: "failed", error: { kind: "timeout" } });
    expect(s.jobs[1].state).toBe("done");
    expect(h.mock.interrupts).toBeGreaterThanOrEqual(1);
  }, 20000);

  test("abort file: interrupt, remaining jobs failed, phase aborted", async () => {
    const h = await harness({ jobs: 2, mode: "hang", limits: { jobTimeoutSec: 60 } });
    await h.run("fk_kick.py");
    await h.waitFor((s) => s.jobs[0].state === "running" && s.jobs[0].promptId);
    const ab = await h.run("fk_abort.py");
    expect(ab.status).toMatchObject({ ok: true });
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("aborted");
    expect(s.jobs.every((j: any) => j.state === "failed" && j.error.kind === "aborted")).toBe(true);
    expect(h.mock.interrupts).toBeGreaterThanOrEqual(1);
    expect(h.mock.prompts.length).toBe(1); // job 2 was never submitted
  }, 20000);

  test("watchdog: stale/missing host heartbeat mid-run -> aborted + self_release marker", async () => {
    const h = await harness({ jobs: 1, mode: "hang", limits: { jobTimeoutSec: 60, idleTtlSec: 1 } });
    await h.run("fk_kick.py"); // kick touches the heartbeat once; nobody polls afterwards
    const end = Date.now() + 10000;
    while (!existsSync(h.marker) && Date.now() < end) await sleep(100);
    const m = JSON.parse(readFileSync(h.marker, "utf8"));
    expect(m.reason).toBe("heartbeat-missing");
    const s = h.status();
    expect(s.phase).toBe("aborted");
    expect(s.error).toContain("watchdog");
    expect(s.jobs[0]).toMatchObject({ state: "failed", error: { kind: "aborted" } });
    // M3 review: the watchdog also leaves a request for the kernel-side release (fk_poll.py)
    expect(JSON.parse(readFileSync(join(h.root, "release.request"), "utf8")).reason).toBe("heartbeat-missing");
    // the runner process ended itself after releasing
    const pid = Number(readFileSync(join(h.root, "runner.pid"), "utf8"));
    await sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20000);

  test("watchdog: hard deadline in the past fires immediately even with fresh heartbeats", async () => {
    const h = await harness({ jobs: 1, mode: "hang", limits: { jobTimeoutSec: 60, hardDeadlineEpoch: Math.floor(Date.now() / 1000) - 5 } });
    await h.run("fk_kick.py");
    const end = Date.now() + 10000;
    while (!existsSync(h.marker) && Date.now() < end) await sleep(100);
    expect(JSON.parse(readFileSync(h.marker, "utf8")).reason).toBe("hard-deadline");
  }, 20000);

  test("self-release fallback: fk_poll reports releasing:true, THEN calls google.colab.runtime.unassign()", async () => {
    const h = await harness({ jobs: 1, mode: "hang", limits: { jobTimeoutSec: 60, hardDeadlineEpoch: Math.floor(Date.now() / 1000) - 5 } });
    const stub = join(h.base, "kernel-unassigned.txt");
    const kernelEnv = { PYTHONPATH: FAKE_PYLIB, FAKE_COLAB_RELEASE_FILE: stub };
    await h.run("fk_kick.py");
    const end = Date.now() + 10000;
    while (!existsSync(join(h.root, "release.request")) && Date.now() < end) await sleep(100);
    expect(existsSync(h.marker)).toBe(true); // the runner's own attempt is kept
    expect(existsSync(stub)).toBe(false); // ... and the kernel-side one has not happened yet

    const poll = await h.run("fk_poll.py", kernelEnv);
    expect(poll.lines.length).toBe(1);
    expect(poll.status).toMatchObject({ releasing: true, phase: "aborted", runnerAlive: false });
    expect(poll.status.watchdog.reason).toBe("hard-deadline");
    expect(poll.stderr).toBe("");
    expect(existsSync(stub)).toBe(true);
    expect(poll.stdout.startsWith("FKSTATUS ")).toBe(true); // the line is printed before unassign() is attempted
  }, 20000);

  test("fk_poll without release.request never unassigns and does not set releasing", async () => {
    const h = await harness({ jobs: 1 });
    const stub = join(h.base, "kernel-unassigned.txt");
    await h.run("fk_kick.py");
    await h.waitFor(terminal);
    const poll = await h.run("fk_poll.py", { PYTHONPATH: FAKE_PYLIB, FAKE_COLAB_RELEASE_FILE: stub });
    expect(poll.status.phase).toBe("done");
    expect("releasing" in poll.status).toBe(false);
    expect(existsSync(stub)).toBe(false);
  }, 20000);

  test("fk_poll: if unassign() itself fails the FKSTATUS line still says releasing, error goes to stderr", async () => {
    const h = await harness({ jobs: 1, mode: "hang", limits: { jobTimeoutSec: 60, hardDeadlineEpoch: Math.floor(Date.now() / 1000) - 5 } });
    await h.run("fk_kick.py");
    const end = Date.now() + 10000;
    while (!existsSync(join(h.root, "release.request")) && Date.now() < end) await sleep(100);
    // stub without FAKE_COLAB_RELEASE_FILE / FAKE_COLAB_SESSION_DIR raises RuntimeError
    const poll = await h.run("fk_poll.py", { PYTHONPATH: FAKE_PYLIB, FAKE_COLAB_RELEASE_FILE: "", FAKE_COLAB_SESSION_DIR: "" });
    expect(poll.status.releasing).toBe(true);
    expect(poll.stderr).toContain("unassign failed");
  }, 20000);

  test("missing node class: phase failed with a clear error, nothing submitted", async () => {
    const h = await harness({ jobs: 1, classes: ["SaveVideo"], requiredClasses: ["SaveVideo", "Ref2VAVSAGatePatch"] });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.phase).toBe("failed");
    expect(s.error).toContain("Ref2VAVSAGatePatch");
    expect(s.jobs[0].state).toBe("failed");
    expect(h.mock.prompts.length).toBe(0);
  }, 20000);

  test("fk_kick is idempotent while the runner is alive and never re-runs a finished batch", async () => {
    const h = await harness({ jobs: 1 });
    const first = await h.run("fk_kick.py");
    expect(first.status).toMatchObject({ ok: true, kicked: true });
    const again = await h.run("fk_kick.py");
    expect(again.status).toMatchObject({ ok: true, kicked: false, reason: "runner-alive", pid: first.status.pid });
    await h.waitFor(terminal);
    const third = await h.run("fk_kick.py");
    expect(third.status.kicked).toBe(false);
    expect(h.mock.prompts.length).toBe(1);
  }, 20000);

  test("kick rejects a bundle with a `..` or absolute member and writes nothing", async () => {
    for (const evil of ["../evil.txt", "/tmp/fk-evil-abs.txt"]) {
      const h = await harness({ noBundle: true });
      const py = `import tarfile,io,sys\nt=tarfile.open(sys.argv[1],'w:gz')\ni=tarfile.TarInfo(sys.argv[2]); i.size=2\nt.addfile(i,io.BytesIO(b'xx'))\nt.close()`;
      const p = Bun.spawn(["python3", "-c", py, join(h.root, "bundle.tar.gz"), evil]);
      await p.exited;
      const r = await h.run("fk_kick.py");
      expect(r.status.ok).toBe(false);
      expect(r.status.error).toContain("unsafe path");
      expect(existsSync(join(h.base, "evil.txt"))).toBe(false);
      expect(existsSync("/tmp/fk-evil-abs.txt")).toBe(false);
      expect(existsSync(join(h.root, "runner.pid"))).toBe(false);
    }
  }, 20000);

  test("kick rejects symlink members", async () => {
    const h = await harness({ noBundle: true });
    const py = `import tarfile,sys\nt=tarfile.open(sys.argv[1],'w:gz')\ni=tarfile.TarInfo('link'); i.type=tarfile.SYMTYPE; i.linkname='/etc/passwd'\nt.addfile(i)\nt.close()`;
    await Bun.spawn(["python3", "-c", py, join(h.root, "bundle.tar.gz")]).exited;
    const r = await h.run("fk_kick.py");
    expect(r.status.ok).toBe(false);
    expect(r.status.error).toContain("unsupported bundle member");
  }, 20000);

  test("kick without a bundle fails explicitly (ok:false, no exception, one line)", async () => {
    const h = await harness({ noBundle: true });
    const r = await h.run("fk_kick.py");
    expect(r.lines.length).toBe(1);
    expect(r.status).toMatchObject({ ok: false });
    expect(r.status.error).toContain("bundle not found");
  }, 20000);

  test("poll prints exactly one FKSTATUS line (status.json) and touches the heartbeat", async () => {
    const h = await harness({ jobs: 1, mode: "hang", limits: { jobTimeoutSec: 60 } });
    const early = await h.run("fk_poll.py"); // nothing started yet
    expect(early.lines.length).toBe(1);
    expect(early.status).toMatchObject({ ok: false });
    await h.run("fk_kick.py");
    await h.waitFor((s) => s.phase === "generating");
    const hb = join(h.root, "host.heartbeat");
    const before = (await Bun.file(hb).stat()).mtimeMs;
    await sleep(60);
    const r = await h.run("fk_poll.py");
    expect(r.lines.length).toBe(1);
    expect(r.stdout.trim().split("\n").length).toBe(1);
    expect(r.status).toMatchObject({ protocol: "colab-comfy/v1", phase: "generating", runnerAlive: true });
    expect(r.status.jobs.length).toBe(1);
    expect((await Bun.file(hb).stat()).mtimeMs).toBeGreaterThan(before);
  }, 20000);

  test("secrets.env is consumed (deleted) and its values never reach status or logs", async () => {
    const secret = "hf_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123";
    const h = await harness({ jobs: 1, secrets: `HF_TOKEN=${secret}\n` });
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(existsSync(join(h.root, "secrets.env"))).toBe(false);
    expect(JSON.stringify(s)).not.toContain(secret);
    for (const f of readdirSync(join(h.root, "logs"))) expect(readFileSync(join(h.root, "logs", f), "utf8")).not.toContain(secret);
  }, 20000);

  test("FK_FAKE_ENV fixture is loaded into status.env", async () => {
    const fixture = JSON.stringify({ gpu: { name: "NVIDIA L4", driver: "580.82.07", memoryMiB: 23034 }, python: "3.12.0" });
    const h = await harness({ jobs: 1 });
    const fx = join(h.base, "env.json");
    writeFileSync(fx, fixture);
    h.env.FK_FAKE_ENV = fx;
    await h.run("fk_kick.py");
    const s = await h.waitFor(terminal);
    expect(s.env).toEqual(JSON.parse(fixture));
  }, 20000);

  test("setup plan: weights group per (repo, revision, local-dir) with the pinned layout", async () => {
    const py = `import json,sys\nsys.path.insert(0, ${JSON.stringify(VM)})\nimport fk_setup\n` +
      `g,e=fk_setup.weight_plan(json.load(open(sys.argv[1])), '/m')\n` +
      `print(json.dumps({'groups':[[k[0],k[1],k[2],v] for k,v in g.items()],'paths':[x[0] for x in e]}))`;
    const mf = join(sampleDir, "manifest.json");
    writeFileSync(mf, JSON.stringify(MANIFEST));
    const p = Bun.spawn(["python3", "-c", py, mf], { stdout: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const out = JSON.parse(await new Response(p.stdout).text());
    expect(out.groups.length).toBe(3);
    const comfyOrg = out.groups.find((g: any) => g[0] === "Comfy-Org/MiniMax-H3");
    expect(comfyOrg[2]).toBe("/m");
    expect(comfyOrg[3].length).toBe(4);
    const lora = out.groups.find((g: any) => g[0] === "lightx2v/Minimax-h3-Turbo");
    expect(lora[2]).toBe("/m/loras");
    expect(out.paths).toContain("/m/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    expect(out.paths).toContain("/m/loras/fasth3_vsa_gate.safetensors");
  }, 20000);
});
