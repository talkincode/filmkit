// Encrypted credential vault (~/.filmkit/vault.enc).
// Stores API keys and secrets securely at rest with AES-256-GCM.
// Never exposes secret values on CLI arguments, in logs, or in project lock files.

import { execSync, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilmkitError, invalid, io } from "./errors.ts";
import { filmkitHome } from "./profile.ts";

const MAGIC = "FKV1"; // 4-byte header
const KEY_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export interface VaultEntry {
  value: string;
  updatedAt: string;
}

export interface VaultData {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export interface VaultKeyItem {
  name: string;
  updatedAt: string;
}

/** Ensure the directory exists with mode 0700. */
function ensureVaultDir(): string {
  const dir = filmkitHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {}
  }
  return dir;
}

/** Get or create a 32-byte master key. */
export function getMasterKey(): Buffer {
  const dir = ensureVaultDir();
  const keyFile = join(dir, "vault.key");

  // In test environments or when explicitly directed by FILMKIT_HOME,
  // or on non-macOS systems, use the secure 0600 keyfile.
  if (process.env.FILMKIT_HOME || process.platform !== "darwin") {
    return getKeyFromKeyfile(keyFile);
  }

  // On macOS without custom FILMKIT_HOME, attempt macOS Keychain first
  try {
    const r = spawnSync("security", ["find-generic-password", "-s", "filmkit-vault", "-a", "master-key", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0 && r.stdout.trim().length === 64) {
      return Buffer.from(r.stdout.trim(), "hex");
    }
    // Not found in keychain -> generate and store
    const newKey = randomBytes(32);
    const hex = newKey.toString("hex");
    const add = spawnSync("security", ["add-generic-password", "-s", "filmkit-vault", "-a", "master-key", "-w", hex, "-U"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (add.status === 0) {
      return newKey;
    }
  } catch {
    // If keychain access throws or is blocked, fall back to keyfile
  }

  return getKeyFromKeyfile(keyFile);
}

function getKeyFromKeyfile(keyFile: string): Buffer {
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile);
    if (raw.length === 32) return raw;
    if (raw.length === 64) return Buffer.from(raw.toString("utf8").trim(), "hex");
  }
  const newKey = randomBytes(32);
  writeFileSync(keyFile, newKey, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {}
  return newKey;
}

export function vaultFilePath(): string {
  return join(filmkitHome(), "vault.enc");
}

/** Read and decrypt vault data. Returns empty vault if file does not exist. */
export function readVault(): VaultData {
  const path = vaultFilePath();
  if (!existsSync(path)) {
    return { version: 1, entries: {} };
  }

  const buf = readFileSync(path);
  if (buf.length < 32 || buf.subarray(0, 4).toString("utf8") !== MAGIC) {
    throw new FilmkitError(
      io(`vault file is corrupted or not a filmkit vault: ${path}`, {
        hint: "file format mismatch or truncated data; check permissions or backup",
      }),
    );
  }

  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);

  const masterKey = getMasterKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as VaultData;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") {
      throw new Error("invalid vault structure");
    }
    return parsed;
  } catch (err) {
    throw new FilmkitError(
      io(`failed to decrypt vault: ${path}`, {
        hint: "encryption authentication failed or file corrupted; check master key",
      }),
    );
  }
}

/** Encrypt and atomically write vault data. */
export function writeVault(data: VaultData): void {
  const dir = ensureVaultDir();
  const path = vaultFilePath();
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;

  const masterKey = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);

  const plaintext = JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const magicBuf = Buffer.from(MAGIC, "utf8");
  const output = Buffer.concat([magicBuf, iv, tag, ciphertext]);

  try {
    writeFileSync(tmpPath, output, { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {}
    renameSync(tmpPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
    throw new FilmkitError(io(`failed to write vault file: ${(err as Error).message}`));
  }
}

export function validateKeyName(name: string): void {
  if (!KEY_NAME_REGEX.test(name)) {
    throw new FilmkitError(
      invalid(`invalid secret name "${name}": must match /^[A-Z_][A-Z0-9_]*$/ (e.g. ARK_API_KEY, GEMINI_API_KEY)`),
    );
  }
}

/** Read secret from stdin or hidden TTY prompt. */
export function readSecretFromStdin(promptMsg?: string): string {
  if (process.stdin.isTTY) {
    if (promptMsg) process.stderr.write(promptMsg);
    let echoDisabled = false;
    try {
      execSync("stty -echo", { stdio: "inherit" });
      echoDisabled = true;
    } catch {}
    try {
      const fd = openSync("/dev/tty", "r");
      let input = "";
      const buf = Buffer.alloc(1);
      while (true) {
        const bytesRead = readSync(fd, buf, 0, 1, null);
        if (bytesRead === 0) break;
        const char = buf.toString("utf8");
        if (char === "\n" || char === "\r") break;
        if (char === "\x7f" || char === "\b") {
          input = input.slice(0, -1);
        } else if (char === "\u0003") {
          process.stderr.write("\n");
          process.exit(130);
        } else if (char === "\u0004") {
          break;
        } else {
          input += char;
        }
      }
      closeSync(fd);
      process.stderr.write("\n");
      return input.trim();
    } finally {
      if (echoDisabled) {
        try {
          execSync("stty echo", { stdio: "inherit" });
        } catch {}
      }
    }
  }

  // Non-TTY / piped input
  const content = readFileSync(0, "utf8");
  return content.replace(/\r?\n$/, "");
}

/** Set a secret in the vault. */
export function vaultSet(name: string, extraArgs: string[], inputOverride?: string): { ok: true; name: string; updatedAt: string } {
  if (!name) {
    throw new FilmkitError(invalid("vault set requires a secret name: filmkit vault set <NAME>"));
  }
  if (extraArgs.length > 0) {
    throw new FilmkitError(
      invalid(
        `filmkit vault set refuses secret values passed on the command line to prevent secret leakage in shell history and ps.\n` +
          `Pass via stdin instead: echo "<secret>" | filmkit vault set ${name}`,
      ),
    );
  }

  validateKeyName(name);

  const value = inputOverride !== undefined ? inputOverride : readSecretFromStdin(`Enter secret for ${name}: `);
  if (!value) {
    throw new FilmkitError(invalid(`secret value for "${name}" cannot be empty`));
  }

  const vault = readVault();
  const updatedAt = new Date().toISOString();
  vault.entries[name] = { value, updatedAt };
  writeVault(vault);

  return { ok: true, name, updatedAt };
}

/** Import secrets from a .env file. */
export function vaultImport(filePath: string): { imported: string[]; path: string } {
  if (!filePath) {
    throw new FilmkitError(invalid("vault import requires a file path: filmkit vault import <file>"));
  }
  if (!existsSync(filePath)) {
    throw new FilmkitError(io(`file not found: ${filePath}`));
  }

  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const toImport: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    validateKeyName(key);
    if (val) {
      toImport[key] = val;
    }
  }

  if (Object.keys(toImport).length === 0) {
    return { imported: [], path: filePath };
  }

  const vault = readVault();
  const now = new Date().toISOString();
  const imported: string[] = [];

  for (const [key, val] of Object.entries(toImport)) {
    vault.entries[key] = { value: val, updatedAt: now };
    imported.push(key);
  }

  writeVault(vault);
  return { imported, path: filePath };
}

/** List all secret names and updated times. Never returns values. */
export function vaultList(): VaultKeyItem[] {
  const vault = readVault();
  return Object.entries(vault.entries)
    .map(([name, entry]) => ({ name, updatedAt: entry.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete a secret from the vault. */
export function vaultDelete(name: string): { ok: true; deleted: string } {
  if (!name) {
    throw new FilmkitError(invalid("vault delete requires a secret name: filmkit vault delete <NAME>"));
  }
  validateKeyName(name);

  const vault = readVault();
  if (!vault.entries[name]) {
    throw new FilmkitError(invalid(`secret "${name}" not found in vault`));
  }

  delete vault.entries[name];
  writeVault(vault);
  return { ok: true, deleted: name };
}

/** Load all vaulted secrets as an env dictionary. */
export function loadVaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const vault = readVault();
    for (const [k, v] of Object.entries(vault.entries)) {
      env[k] = v.value;
    }
  } catch (err) {
    // If the file exists and is corrupted, rethrow so callers don't silently ignore corruption
    if (existsSync(vaultFilePath())) {
      throw err;
    }
  }
  return env;
}

/**
 * Return process environment merged with vault secrets.
 * Precedence: process.env (if non-empty) > vault.
 */
export function effectiveEnv(extra?: Record<string, string>): Record<string, string> {
  const vault = loadVaultEnv();
  const env: Record<string, string> = { ...vault };

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== "") {
      env[k] = v;
    }
  }

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
  }

  return env;
}
