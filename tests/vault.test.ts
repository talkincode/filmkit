// E2E and failure-recovery tests for built-in credential vault (filmkit vault).
// Verifies AES-256-GCM encryption, Keychain/keyfile master key, write-only CLI,
// zero-leak subprocess injection (HTTP + CLI), and corrupted vault protections.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { effectiveEnv, vaultFilePath, vaultSet } from "../src/vault.ts";

const REPO = resolve(import.meta.dir, "..");
const FILMKIT_BIN = join(REPO, "bin/filmkit.ts");

describe("filmkit vault", () => {
  let tempDir: string;
  let vaultHome: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "filmkit-vault-test-"));
    vaultHome = join(tempDir, ".filmkit");
    projectDir = join(tempDir, "project");
    mkdirSync(vaultHome, { recursive: true, mode: 0o700 });
    mkdirSync(projectDir, { recursive: true });

    prevHome = process.env.FILMKIT_HOME;
    process.env.FILMKIT_HOME = vaultHome;
  });

  afterEach(() => {
    if (prevHome !== undefined) {
      process.env.FILMKIT_HOME = prevHome;
    } else {
      delete process.env.FILMKIT_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runCli(args: string[], opts?: { cwd?: string; input?: string; env?: Record<string, string> }) {
    const r = spawnSync(process.execPath, [FILMKIT_BIN, ...args], {
      cwd: opts?.cwd ?? projectDir,
      env: { ...process.env, FILMKIT_HOME: vaultHome, ...(opts?.env ?? {}) },
      input: opts?.input,
      encoding: "utf8",
    });
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      json: <T = Record<string, unknown>>(): T | undefined => {
        try {
          return JSON.parse(r.stdout) as T;
        } catch {
          return undefined;
        }
      },
      errJson: <T = { errors: { code: string; message: string; hint?: string }[] }>(): T | undefined => {
        try {
          return JSON.parse(r.stderr) as T;
        } catch {
          return undefined;
        }
      },
    };
  }

  function standardFilm(customProfilePath: string, sceneImpl: string, produces: string): string {
    return `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: vault-test }
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
  - ref: ${customProfilePath}
output:
  container: mp4
  video: { width: 320, height: 180, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: s1
    duration: 1
    durationPolicy: exact
    impl:
${sceneImpl}
    produces:
${produces}
`;
  }

  test("happy path: set secret via stdin, list names & timestamps, verify at-rest encryption and 0600 mode", () => {
    // 1. Initial empty list
    const empty = runCli(["vault", "list", "--json"]);
    expect(empty.status).toBe(0);
    expect(empty.json<{ keys: unknown[] }>()?.keys).toEqual([]);

    const emptyText = runCli(["vault", "list"]);
    expect(emptyText.status).toBe(0);
    expect(emptyText.stdout).toContain("vault is empty");

    // 2. Set secret via stdin
    const secretVal = "super-secret-api-key-98765";
    const setRes = runCli(["vault", "set", "ARK_API_KEY", "--json"], { input: `${secretVal}\n` });
    expect(setRes.status).toBe(0);
    const setJson = setRes.json<{ ok: boolean; name: string; updatedAt: string }>()!;
    expect(setJson.ok).toBe(true);
    expect(setJson.name).toBe("ARK_API_KEY");
    expect(typeof setJson.updatedAt).toBe("string");

    // 3. Vault file is created with 0600 mode and starts with magic FKV1
    const vPath = vaultFilePath();
    expect(existsSync(vPath)).toBe(true);
    const st = statSync(vPath);
    expect(st.mode & 0o777).toBe(0o600);

    const rawBytes = readFileSync(vPath);
    expect(rawBytes.subarray(0, 4).toString("utf8")).toBe("FKV1");
    // Secret plaintext MUST NOT exist anywhere in raw encrypted bytes!
    expect(rawBytes.includes(Buffer.from(secretVal))).toBe(false);

    // 4. List returns name and timestamp, NEVER prints secret value
    const listRes = runCli(["vault", "list", "--json"]);
    expect(listRes.status).toBe(0);
    const listJson = listRes.json<{ keys: { name: string; updatedAt: string }[] }>()!;
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0]!.name).toBe("ARK_API_KEY");
    expect(listRes.stdout).not.toContain(secretVal);
    expect(listRes.stderr).not.toContain(secretVal);

    // Human readable text output formatting
    const listText = runCli(["vault", "list"]);
    expect(listText.status).toBe(0);
    expect(listText.stdout).toContain("ARK_API_KEY");
    expect(listText.stdout).not.toContain(secretVal);
  });

  test("argv-leak prevention: refuses secret value passed on command line with exit 2", () => {
    const leakAttempt = runCli(["vault", "set", "GEMINI_API_KEY", "sk-leak-in-argv", "--json"]);
    expect(leakAttempt.status).toBe(2);
    expect(leakAttempt.stderr).toContain("refuses secret values passed on the command line");
    const err = leakAttempt.errJson<{ errors: { code: string; message: string }[] }>()!;
    expect(err.errors[0]!.code).toBe("invalid-input");

    // Ensure the key was NOT written to vault
    expect(existsSync(vaultFilePath())).toBe(false);
  });

  test("invalid key name and empty value are rejected with exit 2", () => {
    // Lowercase
    const r1 = runCli(["vault", "set", "lowercase_key", "--json"], { input: "val\n" });
    expect(r1.status).toBe(2);
    expect(r1.errJson()!.errors[0]!.code).toBe("invalid-input");

    // Hyphens
    const r2 = runCli(["vault", "set", "BAD-NAME", "--json"], { input: "val\n" });
    expect(r2.status).toBe(2);
    expect(r2.errJson()!.errors[0]!.code).toBe("invalid-input");

    // Empty value
    const r3 = runCli(["vault", "set", "VALID_KEY", "--json"], { input: "\n" });
    expect(r3.status).toBe(2);
    expect(r3.errJson()!.errors[0]!.message).toContain("cannot be empty");

    // Missing secret name
    const r4 = runCli(["vault", "set", "--json"], { input: "val\n" });
    expect(r4.status).toBe(2);
  });

  test("delete: removes key; deleting non-existent key fails with exit 2", () => {
    runCli(["vault", "set", "TO_DELETE", "--json"], { input: "secret123\n" });
    expect(runCli(["vault", "list", "--json"]).json<{ keys: unknown[] }>()!.keys).toHaveLength(1);

    // Delete existing
    const del = runCli(["vault", "delete", "TO_DELETE", "--json"]);
    expect(del.status).toBe(0);
    expect(del.json<{ ok: boolean; deleted: string }>()!).toEqual({ ok: true, deleted: "TO_DELETE" });
    expect(runCli(["vault", "list", "--json"]).json<{ keys: unknown[] }>()!.keys).toHaveLength(0);

    // Delete non-existent
    const delAgain = runCli(["vault", "delete", "TO_DELETE", "--json"]);
    expect(delAgain.status).toBe(2);
    expect(delAgain.errJson()!.errors[0]!.code).toBe("invalid-input");
  });

  test("import: imports keys from .env format file and validates keys", () => {
    const envFile = join(tempDir, "test.env");
    writeFileSync(
      envFile,
      `
# Comments should be ignored
export ARK_API_KEY="ark-secret-123"

# Blank lines above
GEMINI_API_KEY='gemini-secret-456'
THIRD_KEY=bare_value_789
`,
      "utf8",
    );

    const imp = runCli(["vault", "import", envFile, "--json"]);
    expect(imp.status).toBe(0);
    const impJson = imp.json<{ imported: string[]; path: string }>()!;
    expect(impJson.imported).toEqual(["ARK_API_KEY", "GEMINI_API_KEY", "THIRD_KEY"]);

    const list = runCli(["vault", "list", "--json"]).json<{ keys: { name: string }[] }>()!;
    expect(list.keys.map((k) => k.name)).toEqual(["ARK_API_KEY", "GEMINI_API_KEY", "THIRD_KEY"]);

    // Missing import file fails with exit 1 (io)
    const badImp = runCli(["vault", "import", join(tempDir, "missing.env"), "--json"]);
    expect(badImp.status).toBe(1);
    expect(badImp.errJson()!.errors[0]!.code).toBe("io");
  });

  test("precedence: process.env overrides vault, empty/unset process.env uses vault", () => {
    vaultSet("MY_CONFIG_KEY", [], "vault_value");

    // 1. Without ambient env var
    delete process.env.MY_CONFIG_KEY;
    const eff1 = effectiveEnv();
    expect(eff1.MY_CONFIG_KEY).toBe("vault_value");

    // 2. Ambient env var set -> overrides vault
    process.env.MY_CONFIG_KEY = "env_override_value";
    const eff2 = effectiveEnv();
    expect(eff2.MY_CONFIG_KEY).toBe("env_override_value");

    // 3. Ambient env var is empty string -> vault value is used
    process.env.MY_CONFIG_KEY = "";
    const eff3 = effectiveEnv();
    expect(eff3.MY_CONFIG_KEY).toBe("vault_value");

    delete process.env.MY_CONFIG_KEY;
  });

  test("subprocess injection (CLI profile): child process receives vaulted key in env", () => {
    vaultSet("CLI_SECRET_KEY", [], "injected-secret-val");

    mkdirSync(join(projectDir, "profiles"), { recursive: true });
    writeFileSync(
      join(projectDir, "profiles/echoer.yaml"),
      `apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: echoer, version: "1.0" }
runtime:
  type: cli
  binary: sh
  requires: { env: [CLI_SECRET_KEY] }
tasks:
  run-echo:
    invocation: ["sh", "-c", "echo $CLI_SECRET_KEY > \${produces.file}"]
    paramsSchema: { type: object }
`,
      "utf8",
    );

    writeFileSync(
      join(projectDir, "filmkit.yaml"),
      standardFilm("./profiles/echoer.yaml", "      profile: echoer\n      task: run-echo", "      file: ./build/secret.txt"),
      "utf8",
    );

    delete process.env.CLI_SECRET_KEY;
    const runRes = runCli(["run", "s1", "--json"]);
    expect(runRes.status).toBe(0);

    const secretFile = join(projectDir, "build/secret.txt");
    expect(existsSync(secretFile)).toBe(true);
    expect(readFileSync(secretFile, "utf8").trim()).toBe("injected-secret-val");
  });

  test("subprocess injection (HTTP profile): worker receives vaulted key via effectiveEnv", async () => {
    const stubKey = "vault-token-xyz";
    const server = spawn(["bun", new URL("./stub-api-server.ts", import.meta.url).pathname], {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, STUB_API_KEY: stubKey },
    });
    const out = server.stdout;
    if (typeof out === "number" || out === undefined) throw new Error("stub api stdout is not piped");
    const reader = out.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value);
    const match = /http:\/\/([^\s]+)/.exec(line);
    if (!match) throw new Error(`stub api did not report a URL: ${line}`);
    const base = `http://${match[1]}`;

    try {
      vaultSet("ARK_API_KEY", [], stubKey);

      mkdirSync(join(projectDir, "profiles"), { recursive: true });
      writeFileSync(
        join(projectDir, "profiles/seedance.yaml"),
        `apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: seedance, version: "1.0" }
runtime:
  type: http
  requires: { env: [ARK_API_KEY] }
tasks:
  text-to-video:
    http:
      create:
        method: POST
        url: "${base}/tasks"
        headers:
          Authorization: "Bearer \${env.ARK_API_KEY}"
        json:
          model: "doubao-seedance-1-0-pro-250528"
          content: [{ type: text, text: "prompt" }]
      poll:
        method: GET
        url: "${base}/tasks/\${create.id}?polls=1"
        headers:
          Authorization: "Bearer \${env.ARK_API_KEY}"
        every: 0.1
        timeout: 5
        until: { path: status, equals: succeeded }
        failed: [{ path: status, equals: failed }]
      output:
        download:
          path: "\${create.content.video_url}"
          headers:
            Authorization: "Bearer \${env.ARK_API_KEY}"
    paramsSchema: { type: object }
`,
        "utf8",
      );

      writeFileSync(
        join(projectDir, "filmkit.yaml"),
        standardFilm("./profiles/seedance.yaml", "      profile: seedance\n      task: text-to-video", "      video: ./build/s1.mp4"),
        "utf8",
      );

      // Ensure ARK_API_KEY is NOT in ambient process.env
      delete process.env.ARK_API_KEY;

      const r = runCli(["run", "s1", "--json"]);
      expect(r.status).toBe(0);
      expect(existsSync(join(projectDir, "build/s1.mp4"))).toBe(true);
      expect(readFileSync(join(projectDir, "build/s1.mp4")).length).toBeGreaterThan(100);

      // Lock file records produce and does NOT contain secret
      const lockContent = readFileSync(join(projectDir, "filmkit.lock.yaml"), "utf8");
      expect(lockContent).not.toContain(stubKey);
    } finally {
      server.kill();
    }
  }, 30_000);

  test("failure recovery: corrupted vault file throws io error and is never silently wiped or overwritten", () => {
    // 1. Create a corrupted vault file (invalid magic, truncated bytes)
    const vPath = vaultFilePath();
    writeFileSync(vPath, Buffer.from("NOT_A_VALID_VAULT_FILE"), { mode: 0o600 });
    const originalMtime = statSync(vPath).mtimeMs;

    // 2. Listing fails explicitly with code 1 (io)
    const listCorrupt = runCli(["vault", "list", "--json"]);
    expect(listCorrupt.status).toBe(1);
    expect(listCorrupt.errJson()!.errors[0]!.code).toBe("io");
    expect(listCorrupt.errJson()!.errors[0]!.message).toContain("corrupted or not a filmkit vault");

    // Corrupted file was NOT touched or deleted
    expect(existsSync(vPath)).toBe(true);
    expect(statSync(vPath).mtimeMs).toBe(originalMtime);

    // 3. Attempting to set fails with code 1 without deleting the corrupted file
    const setCorrupt = runCli(["vault", "set", "NEW_KEY", "--json"], { input: "val\n" });
    expect(setCorrupt.status).toBe(1);
    expect(existsSync(vPath)).toBe(true);
    expect(readFileSync(vPath).toString("utf8")).toBe("NOT_A_VALID_VAULT_FILE");
  });

  test("doctor integration: reports required env set: true when in vault, exits 0; reports not set when missing", () => {
    mkdirSync(join(projectDir, "profiles"), { recursive: true });
    writeFileSync(
      join(projectDir, "profiles/need-auth.yaml"),
      `apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: need-auth, version: "1.0" }
runtime:
  type: none
  requires: { env: [SECRET_DOCTOR_KEY] }
tasks:
  dummy:
    paramsSchema: { type: object }
`,
      "utf8",
    );

    writeFileSync(
      join(projectDir, "filmkit.yaml"),
      standardFilm("./profiles/need-auth.yaml", "      profile: need-auth\n      task: dummy", "      file: ./build/out.txt"),
      "utf8",
    );

    // 1. When not in env and not in vault -> doctor reports not set and exits 3
    delete process.env.SECRET_DOCTOR_KEY;
    const docMissing = runCli(["doctor", "--json"]);
    expect(docMissing.status).toBe(3);
    const profMissing = docMissing.json<{ profiles: { name: string; env: { name: string; set: boolean }[] }[] }>()!.profiles.find(
      (p) => p.name === "need-auth",
    )!;
    expect(profMissing.env).toEqual([{ name: "SECRET_DOCTOR_KEY", set: false }]);

    // 2. Set into vault -> doctor reports set: true and exits 0!
    runCli(["vault", "set", "SECRET_DOCTOR_KEY", "--json"], { input: "val-12345\n" });
    const docOk = runCli(["doctor", "--json"]);
    expect(docOk.status).toBe(0);
    const profOk = docOk.json<{ profiles: { name: string; env: { name: string; set: boolean }[] }[] }>()!.profiles.find(
      (p) => p.name === "need-auth",
    )!;
    expect(profOk.env).toEqual([{ name: "SECRET_DOCTOR_KEY", set: true }]);

    // Neither stdout nor stderr ever leaks the secret
    expect(docOk.stdout).not.toContain("val-12345");
    expect(docOk.stderr).not.toContain("val-12345");
  });
});
