// Colab driver (src/colab.ts, src/redact.ts) against the fake `colab` shim (test/fake-colab.ts).
// No real `colab`, no network, no money. Python-dependent tests are skipped when python3 is missing.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Colab, isReleasing, parseFkStatus, parseSessions, parseStatus, parseUsage, type CallLogEntry } from "../src/colab.ts";
import { ColabComfyError, EXIT } from "../src/errors.ts";
import { redact, redactDeep } from "../src/redact.ts";
import { FAKE_TOKEN, fakeColabEnv, readCalls, sessionContent } from "./fake-colab.ts";

const VM = join(import.meta.dir, "..", "vm");
const hasPython = Bun.which("python3") !== null;
if (!hasPython) console.warn("SKIP exec tests in colab-driver.test.ts: python3 not found on PATH");
const py = hasPython ? test : test.skip;

// ---- M0 F1 strings, verbatim shapes ----
const SESSIONS_EMPTY = "[colab] No active sessions found on server.\n";
const SESSIONS_ONE = "[fk-m0] https://example.invalid/ep/abc | Hardware: CPU | Shape: Standard | Variant: DEFAULT\n";
const SESSIONS_PRUNED =
  "[colab] Pruned 1 stale local session(s).\n[fk-a] https://example.invalid/ep/a | Hardware: GPU L4 | Shape: Standard | Variant: DEFAULT\n[fk-b] https://example.invalid/ep/b | Hardware: CPU | Shape: Standard | Variant: DEFAULT\n";
const USAGE = "Current balance: 349.19 compute units\nUsage rate: 0.08/hr\nActive assignments: 1\n";

describe("parsers (M0 F1 fixtures)", () => {
  test("sessions: empty, one, pruned notice ignored, many", () => {
    expect(parseSessions(SESSIONS_EMPTY)).toEqual([]);
    expect(parseSessions("")).toEqual([]);
    expect(parseSessions(SESSIONS_ONE)).toEqual([
      { name: "fk-m0", endpoint: "https://example.invalid/ep/abc", hardware: "CPU", shape: "Standard", variant: "DEFAULT" },
    ]);
    expect(parseSessions("[colab] Pruned 1 stale local session(s).\n[colab] No active sessions found on server.\n")).toEqual([]);
    expect(parseSessions(SESSIONS_PRUNED).map((s) => [s.name, s.hardware])).toEqual([
      ["fk-a", "GPU L4"],
      ["fk-b", "CPU"],
    ]);
  });

  test("sessions: an unknown line throws instead of silently hiding a session", () => {
    expect(() => parseSessions("garbage that is not a session\n")).toThrow(ColabComfyError);
  });

  test("usage", () => {
    expect(parseUsage(USAGE)).toEqual({ balance: 349.19, rate: 0.08, assignments: 1 });
    expect(() => parseUsage("Current balance: 1.00 compute units\n")).toThrow(ColabComfyError);
  });

  test("status: idle, busy with marker, last execution, missing", () => {
    expect(parseStatus("[s1] https://e.invalid/x | Hardware: GPU L4 | Shape: Standard | Variant: DEFAULT | Status: IDLE\n")).toEqual({
      found: true, name: "s1", hardware: "GPU L4", state: "IDLE",
    });
    const busy = parseStatus(
      "[s1] https://e.invalid/x | Hardware: CPU | Shape: Standard | Variant: DEFAULT | Status: BUSY (exec(p4_sleep.py))\n  Last Execution: p3.py at 2026-10-18 09:21:30\n",
    );
    expect(busy).toEqual({ found: true, name: "s1", hardware: "CPU", state: "BUSY", busyWith: "exec(p4_sleep.py)", lastExecution: "p3.py at 2026-10-18 09:21:30" });
    expect(parseStatus("[colab] Session 'nope' not found.\n")).toEqual({ found: false });
  });

  test("FKSTATUS: last valid JSON-object line wins; noise and bad JSON are ignored", () => {
    expect(parseFkStatus('noise\nFKSTATUS {"a":1}\nmore\nFKSTATUS {"a":2}\n')).toEqual({ a: 2 });
    expect(parseFkStatus('FKSTATUS {"a":1}\nFKSTATUS {broken\n')).toEqual({ a: 1 });
    expect(parseFkStatus("FKSTATUS [1,2]\n")).toBeNull();
    expect(parseFkStatus("Traceback (most recent call last):\n")).toBeNull();
    expect(parseFkStatus('  FKSTATUS {"a":1}\n')).toBeNull(); // must start the line
    expect(isReleasing({ releasing: true })).toBe(true);
    expect(isReleasing({ releasing: "yes" })).toBe(false);
    expect(isReleasing(null)).toBe(false);
  });
});

describe("redact (fake tokens only)", () => {
  const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZw";
  const cases: [string, string, string][] = [
    ["proxy token in a URL", `url: https://x.invalid/api?colab-runtime-proxy-token=${FAKE_TOKEN}&authuser=0`, FAKE_TOKEN],
    ["query token", "GET https://x.invalid/p?a=1&token=FAKESECRETVALUE123 HTTP", "FAKESECRETVALUE123"],
    ["access_token query", "https://x.invalid/p?access_token=FAKEACCESSVALUE", "FAKEACCESSVALUE"],
    ["authuser_token query", "https://x.invalid/p?authuser_token=FAKEAUTHUSERVALUE", "FAKEAUTHUSERVALUE"],
    ["bare JWT", `jwt ${JWT} end`, JWT],
    ["ya29", "oauth ya29.FAKE-oauth_token.value end", "ya29.FAKE-oauth_token.value"],
    ["Bearer", "Authorization: Bearer FAKEBEARERVALUE123", "FAKEBEARERVALUE123"],
    ["hf token", "token hf_" + "A".repeat(34), "hf_" + "A".repeat(34)],
    ["json access_token", '{"access_token": "FAKEJSONACCESS", "x": 1}', "FAKEJSONACCESS"],
    ["json refresh_token", '{"refresh_token":"FAKEJSONREFRESH"}', "FAKEJSONREFRESH"],
    ["google api key", "key=AIza" + "B".repeat(35), "AIza" + "B".repeat(35)],
  ];
  for (const [name, input, secret] of cases) {
    test(name, () => {
      const out = redact(input);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED]");
    });
  }

  test("harmless text is untouched; key names stay readable", () => {
    const plain = "[colab] Session READY. 349.19 compute units, hf_short, token=";
    expect(redact(plain)).toBe(plain);
    expect(redact(`?colab-runtime-proxy-token=${FAKE_TOKEN}`)).toBe("?colab-runtime-proxy-token=[REDACTED]");
    expect(redact('{"refresh_token": "FAKE"}')).toBe('{"refresh_token": "[REDACTED]"}');
  });

  test("redactDeep scrubs nested strings and keeps structure", () => {
    const v = redactDeep({ a: ["Bearer FAKEX1", 3, { b: `?token=FAKEY2&z` }], n: null });
    expect(JSON.stringify(v)).not.toContain("FAKEX1");
    expect(JSON.stringify(v)).not.toContain("FAKEY2");
    expect((v.a as unknown[])[1]).toBe(3);
  });
});

// ---- driver against the fake ----

interface Harness {
  dir: string;
  state: string;
  colab: Colab;
  log: CallLogEntry[];
  script(name: string, body: string): string;
  calls(): string[];
}
const live: string[] = [];
afterEach(() => {
  for (const d of live.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(extraEnv: Record<string, string> = {}, opts: ConstructorParameters<typeof Colab>[0] = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "colab-driver-"));
  live.push(dir);
  const state = join(dir, "state");
  const log: CallLogEntry[] = [];
  const colab = new Colab({ env: fakeColabEnv(state, { FAKE_COLAB_CU_PER_SEC: "0.5", ...extraEnv }), onCall: (e) => log.push(e), ...opts });
  return {
    dir, state, colab, log,
    script(name, body) {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    },
    calls: () => readCalls(state).map((c) => c.sub),
  };
}

describe("driver: queries and lifecycle against the fake", () => {
  test("version, empty sessions, usage", async () => {
    const h = harness();
    expect(await h.colab.version()).toBe("0.7.4");
    expect(await h.colab.sessions()).toEqual([]);
    expect(await h.colab.usage()).toEqual({ balance: 100, rate: 0, assignments: 0 });
  });

  test("global flags: --auth adc by default, COLAB_COMFY_AUTH and --config honoured; no --env anywhere", async () => {
    const a = harness();
    await a.colab.version();
    expect(readCalls(a.state)[0]!.line).toBe("--auth adc version");
    const b = harness({}, { auth: "oauth2", config: "/tmp/fake-sessions.json" });
    await b.colab.sessions();
    expect(readCalls(b.state)[0]!.line).toBe("--auth oauth2 --config /tmp/fake-sessions.json sessions");
    const c = harness({ COLAB_COMFY_AUTH: "adc2", COLAB_CLI_CONFIG: "/tmp/c.json" });
    const env = { ...fakeColabEnv(c.state, { COLAB_COMFY_AUTH: "adc2", COLAB_CLI_CONFIG: "/tmp/c.json" }) };
    await new Colab({ env }).version();
    expect(readCalls(c.state)[0]!.line).toBe("--auth adc2 --config /tmp/c.json version");
  });

  test("newSession: GPU passes --gpu, CPU/undefined omit it; sessions/status/usage reflect it", async () => {
    const h = harness();
    expect((await h.colab.newSession("fk-a", "L4")).ok).toBe(true);
    expect((await h.colab.newSession("fk-b", "CPU")).ok).toBe(true);
    expect((await h.colab.newSession("fk-c")).ok).toBe(true);
    const lines = readCalls(h.state).map((c) => c.line);
    expect(lines).toContain("--auth adc new -s fk-a --gpu L4");
    expect(lines).toContain("--auth adc new -s fk-b");
    expect(lines).toContain("--auth adc new -s fk-c");
    const s = await h.colab.sessions();
    expect(s.map((x) => [x.name, x.hardware])).toEqual([["fk-a", "GPU L4"], ["fk-b", "CPU"], ["fk-c", "CPU"]]);
    expect(await h.colab.status("fk-a")).toMatchObject({ found: true, state: "IDLE", hardware: "GPU L4" });
    expect(await h.colab.status("nope")).toEqual({ found: false });
    expect((await h.colab.usage()).assignments).toBe(3);
    expect((await h.colab.newSession("fk-a", "L4")).ok).toBe(false); // already exists
  });

  test("usage balance decrements with session life and stops after stop()", async () => {
    const h = harness({ FAKE_COLAB_CU_PER_SEC: "2" }); // 2 CU/s: visible at 2 decimals within a second
    await h.colab.newSession("fk-u");
    await Bun.sleep(300);
    const mid = await h.colab.usage();
    expect(mid.balance).toBeLessThan(100);
    expect(mid.rate).toBe(7200);
    await h.colab.stop("fk-u");
    const a = await h.colab.usage();
    await Bun.sleep(200);
    const b = await h.colab.usage();
    expect(a).toEqual(b);
    expect(a.assignments).toBe(0);
    expect(a.balance).toBeLessThan(mid.balance + 0.001);
  });

  test("failed new reports not-ok without throwing (caller must still STOP)", async () => {
    const h = harness({ FAKE_COLAB_FAIL: "new" });
    const r = await h.colab.newSession("fk-x", "L4");
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(await h.colab.sessions()).toEqual([]);
  });

  test("stop: success, then idempotent on a missing session (rc 0 + notFound)", async () => {
    const h = harness();
    await h.colab.newSession("fk-s");
    const r1 = await h.colab.stop("fk-s");
    expect(r1).toMatchObject({ ok: true, notFound: false });
    expect(await h.colab.sessions()).toEqual([]);
    const r2 = await h.colab.stop("fk-s");
    expect(r2).toMatchObject({ ok: true, code: 0, notFound: true });
    expect(r2.stdout).toContain("Session 'fk-s' not found.");
    const r3 = await h.colab.stop("never-existed");
    expect(r3).toMatchObject({ ok: true, notFound: true });
  });

  test("stop fault injection: stop fails once then works; stop-always never releases", async () => {
    const once = harness({ FAKE_COLAB_FAIL: "stop" });
    await once.colab.newSession("fk-o");
    expect((await once.colab.stop("fk-o")).ok).toBe(false);
    expect((await once.colab.sessions()).length).toBe(1);
    expect((await once.colab.stop("fk-o")).ok).toBe(true);
    expect(await once.colab.sessions()).toEqual([]);

    const always = harness({ FAKE_COLAB_FAIL: "stop-always" });
    await always.colab.newSession("fk-l");
    for (let i = 0; i < 3; i++) expect((await always.colab.stop("fk-l")).ok).toBe(false);
    expect((await always.colab.sessions()).map((s) => s.name)).toEqual(["fk-l"]);
  });

  test("missing colab binary -> exit 3 (missing dependency)", async () => {
    const colab = new Colab({ bin: "/nonexistent/dir/colab" });
    try {
      await colab.version();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ColabComfyError);
      expect((err as ColabComfyError).exitCode).toBe(EXIT.missingDependency);
    }
  });

  test("query failure surfaces as exit 4 with redacted detail", async () => {
    const colab = new Colab({ bin: "sh", env: { PATH: process.env.PATH } });
    // `sh --auth adc version`: sh rejects the option, a real non-zero exit through the same code path
    try {
      await colab.version();
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ColabComfyError).exitCode).toBe(EXIT.toolFailure);
    }
  });
});

describe("driver: exec", () => {
  py("success is decided by the FKSTATUS line; marker is parsed and noise ignored", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    const f = h.script("ok.py", 'import os\nprint("noise before")\nprint("FKSTATUS " + \'{"ok": true, "n": 3}\')\nprint("noise after")\n');
    const r = await h.colab.exec("fk-e", f, 20);
    expect(r.fkstatus).toEqual({ ok: true, n: 3 });
    expect(r.timedOut).toBe(false);
    expect(r.sessionNotFound).toBe(false);
    expect(r.stdout).toContain("noise before");
  });

  py("traceback with rc 0 -> no FKSTATUS, error text on stderr (rc is never evidence)", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    const r = await h.colab.exec("fk-e", h.script("boom.py", 'raise RuntimeError("boom")\n'), 20);
    expect(r.code).toBe(0);
    expect(r.fkstatus).toBeNull();
    expect(r.stderr).toContain("Traceback");
    expect(r.stderr).toContain("RuntimeError: boom");
  });

  py("sys.exit(7) is also rc 0 and carries no FKSTATUS", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    const r = await h.colab.exec("fk-e", h.script("exit7.py", 'import sys\nsys.exit(7)\n'), 20);
    expect(r.code).toBe(0);
    expect(r.fkstatus).toBeNull();
    expect(r.stderr).toContain("SystemExit: 7");
  });

  py("a traceback that happens AFTER the marker does not erase it, failure before it does", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    const r = await h.colab.exec("fk-e", h.script("late.py", 'print("FKSTATUS {\\"ok\\":true}")\nraise ValueError("late")\n'), 20);
    expect(r.fkstatus).toEqual({ ok: true });
    expect(r.stderr).toContain("ValueError");
  });

  py("FK_ROOT maps into the session: files created by exec are downloadable", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    const f = h.script("mk.py", 'import os, json\nr = os.environ["FK_ROOT"]\nos.makedirs(r, exist_ok=True)\nopen(os.path.join(r, "a.txt"), "w").write("hello")\nprint("FKSTATUS " + json.dumps({"root": r}))\n');
    const r = await h.colab.exec("fk-e", f, 20);
    expect(r.fkstatus!.root).toBe(join(sessionContent(h.state, "fk-e"), "fk"));
    const local = join(h.dir, "dl", "deep", "a.txt"); // parent does not exist yet (A4)
    const d = await h.colab.download("fk-e", "/content/fk/a.txt", local);
    expect(d.ok).toBe(true);
    expect(readFileSync(local, "utf8")).toBe("hello");
  });

  py("host timeout: client killed, restart-kernel runs, result is a timeout, next exec works", async () => {
    const h = harness({ FAKE_COLAB_HANG: "exec" });
    await h.colab.newSession("fk-h");
    const f = h.script("ok.py", 'print("FKSTATUS {\\"ok\\":true}")\n');
    const t0 = Date.now();
    const r = await h.colab.exec("fk-h", f, 1);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r).toMatchObject({ timedOut: true, fkstatus: null, code: null, kernelRestarted: true });
    const subs = h.calls();
    expect(subs.slice(-2)).toEqual(["exec", "restart-kernel"]);
    const r2 = await h.colab.exec("fk-h", f, 20);
    expect(r2.fkstatus).toEqual({ ok: true });
    expect(r2.timedOut).toBe(false);
  }, 20000);

  py("fake fidelity (A12): after a killed exec client the next exec hangs until restart-kernel", async () => {
    const h = harness({ FAKE_COLAB_HANG: "exec" });
    await h.colab.newSession("fk-h");
    const f = h.script("ok.py", 'print("FKSTATUS {\\"ok\\":true}")\n');
    const killed = await h.colab.run(["exec", "-s", "fk-h", "-f", f], 700); // raw run: no restart-kernel
    expect(killed.timedOut).toBe(true);
    expect(await h.colab.status("fk-h")).toMatchObject({ state: "BUSY" });
    const hung = await h.colab.run(["exec", "-s", "fk-h", "-f", f], 1200);
    expect(hung.timedOut).toBe(true); // still stuck although the hang fault was a one-shot
    await h.colab.restartKernel("fk-h");
    expect(await h.colab.status("fk-h")).toMatchObject({ state: "IDLE" });
    const ok = await h.colab.exec("fk-h", f, 20);
    expect(ok.fkstatus).toEqual({ ok: true });
  }, 20000);

  py("exec failure injection and an exec on a vanished session", async () => {
    const h = harness({ FAKE_COLAB_FAIL: "exec:1" });
    await h.colab.newSession("fk-f");
    const f = h.script("ok.py", 'print("FKSTATUS {\\"ok\\":true}")\n');
    const bad = await h.colab.exec("fk-f", f, 20);
    expect(bad.fkstatus).toBeNull();
    expect(bad.code).toBe(1);
    expect((await h.colab.exec("fk-f", f, 20)).fkstatus).toEqual({ ok: true });
    await h.colab.stop("fk-f");
    const gone = await h.colab.exec("fk-f", f, 20);
    expect(gone).toMatchObject({ fkstatus: null, sessionNotFound: true });
  });

  py("preemption: FAKE_COLAB_DROP=after:2 makes the session vanish after the 2nd exec", async () => {
    const h = harness({ FAKE_COLAB_DROP: "after:2" });
    await h.colab.newSession("fk-d");
    const f = h.script("ok.py", 'print("FKSTATUS {\\"ok\\":true}")\n');
    expect((await h.colab.exec("fk-d", f, 20)).fkstatus).toEqual({ ok: true });
    expect((await h.colab.sessions()).length).toBe(1);
    expect((await h.colab.exec("fk-d", f, 20)).fkstatus).toEqual({ ok: true });
    expect(await h.colab.sessions()).toEqual([]); // pruned line ignored by the parser
    const third = await h.colab.exec("fk-d", f, 20);
    expect(third.sessionNotFound).toBe(true);
    expect((await h.colab.usage()).assignments).toBe(0);
  });

  py("--env is never used and secrets-in-argv are impossible: no call carries it", async () => {
    const h = harness();
    await h.colab.newSession("fk-e");
    await h.colab.exec("fk-e", h.script("ok.py", 'print("FKSTATUS {\\"ok\\":true}")\n'), 20);
    for (const c of readCalls(h.state)) expect(c.line).not.toContain("--env");
  });

  py("google.colab.runtime.unassign() from a cell releases the session", async () => {
    const h = harness();
    await h.colab.newSession("fk-r");
    expect((await h.colab.sessions()).length).toBe(1);
    const f = h.script("unassign.py", 'from google.colab import runtime\nruntime.unassign()\nprint("FKSTATUS {\\"unassigned\\":true}")\n');
    const r = await h.colab.exec("fk-r", f, 20);
    expect(r.fkstatus).toEqual({ unassigned: true });
    expect(await h.colab.sessions()).toEqual([]);
    expect((await h.colab.usage()).assignments).toBe(0);
    expect(await h.colab.status("fk-r")).toEqual({ found: false });
    expect((await h.colab.stop("fk-r")).notFound).toBe(true);
    // the first `sessions` after an unassign prints the "Pruned" notice (M0 F5); the parser coped above
    expect(h.log.some((e) => e.args.includes("sessions") && e.stdout.includes("Pruned 1 stale"))).toBe(true);
  });

  py("fk_mkdirs.py + upload of the bundle path works end to end through the shim", async () => {
    const h = harness();
    await h.colab.newSession("fk-m");
    const local = h.script("bundle.tar.gz", "not really a tarball");
    const before = await h.colab.upload("fk-m", local, "/content/fk/bundle.tar.gz");
    expect(before.ok).toBe(false); // parent dir missing (F4)
    const mk = await h.colab.exec("fk-m", join(VM, "fk_mkdirs.py"), 20);
    expect(mk.fkstatus).toMatchObject({ ok: true });
    const up = await h.colab.upload("fk-m", local, "/content/fk/bundle.tar.gz");
    expect(up.ok).toBe(true);
    expect(readFileSync(join(sessionContent(h.state, "fk-m"), "fk", "bundle.tar.gz"), "utf8")).toBe("not really a tarball");
  });
});

describe("driver: upload/download", () => {
  test("upload into a missing remote dir fails rc 1 and EVERY captured output is redacted", async () => {
    const h = harness();
    await h.colab.newSession("fk-up");
    const local = h.script("x.bin", "data");
    const r = await h.colab.upload("fk-up", local, "/content/missing-dir/x.bin");
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("500");
    const everything = JSON.stringify([r, h.log]);
    expect(everything).not.toContain("eyJ");
    expect(everything).not.toContain("FAKE.JWT");
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).toContain("colab-runtime-proxy-token=[REDACTED]");
  });

  test("upload of a missing local file and of a missing session are rc 1", async () => {
    const h = harness();
    await h.colab.newSession("fk-up");
    expect((await h.colab.upload("fk-up", join(h.dir, "nope.bin"), "/content/x.bin")).ok).toBe(false);
    expect((await h.colab.upload("ghost", h.script("y.bin", "1"), "/content/y.bin")).ok).toBe(false);
  });

  test("upload success then download creates the local parent dir; missing remote and injected failure are rc 1", async () => {
    const h = harness({ FAKE_COLAB_FAIL: "download:1" });
    await h.colab.newSession("fk-dl");
    const local = h.script("c.bin", "payload");
    expect((await h.colab.upload("fk-dl", local, "/content/c.bin")).ok).toBe(true);
    const dest = join(h.dir, "a", "b", "c.bin");
    expect(existsSync(join(h.dir, "a"))).toBe(false);
    const injected = await h.colab.download("fk-dl", "/content/c.bin", dest);
    expect(injected.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(h.dir, "a", "b"))).toBe(true); // parent created before the CLI ran
    const good = await h.colab.download("fk-dl", "/content/c.bin", dest);
    expect(good.ok).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("payload");
    const missing = await h.colab.download("fk-dl", "/content/none.bin", join(h.dir, "z", "none.bin"));
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("File or directory not found");
  });

  test("the shim itself refuses a download whose local parent is missing (rc 1, [Errno 2])", async () => {
    const h = harness();
    await h.colab.newSession("fk-dl");
    await h.colab.upload("fk-dl", h.script("c.bin", "p"), "/content/c.bin");
    const r = await h.colab.run(["download", "-s", "fk-dl", "/content/c.bin", join(h.dir, "no", "parent", "c.bin")], 10000);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("[Errno 2]");
  });

  test("captured output is redacted before onCall sees it (tokens printed by a tool)", async () => {
    const h = harness();
    const wrapper = h.script("leaky.sh", `#!/bin/sh\necho "Authorization: Bearer FAKELEAKBEARER"\necho "hf_${"Z".repeat(36)}" >&2\n`);
    chmodSync(wrapper, 0o755);
    const c = new Colab({ bin: wrapper, env: { PATH: process.env.PATH }, onCall: (e) => h.log.push(e) });
    const r = await c.run(["version"], 5000);
    expect(r.ok).toBe(true);
    expect(JSON.stringify([r, h.log])).not.toContain("FAKELEAKBEARER");
    expect(JSON.stringify([r, h.log])).not.toContain("Z".repeat(36));
    expect(r.stdout).toContain("Bearer [REDACTED]");
  });
});
