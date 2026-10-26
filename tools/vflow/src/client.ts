// The only module that talks to vflow: two read-only GETs over REST.
//   GET /v1/projects/:p/compositions/:c/export   -> the portable bundle
//   GET /v1/projects/:p/assets/:a/content        -> immutable bytes (ETag = sha256)
// (MCP is deliberately not used here: it cannot carry asset bytes, and pushing a
// base64 image through an agent's context is not a transport.)
//
// Two ways through Cloudflare Access, tried in this order:
//   1. a service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET), read from
//      the environment or the filmkit vault (same precedence as `filmkit run`) —
//      for headless agents; the project's owner must have added it as a member;
//   2. the signed-in person's Access login, fetched with `cloudflared access token`
//      after a one-time `cloudflared access login <url>` — for designers reading
//      their own (private) projects; nothing to configure on the vflow side.
// Values only ever travel in request headers; no message, hint or log line
// contains them, and nothing is stored by this tool.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type FileHandle, open, rm } from "node:fs/promises";
import { effectiveEnv } from "../../../src/vault.ts";
import { fail, invalid, io, missingDependency, toolFailure } from "./errors.ts";

export const ENV_CLIENT_ID = "CF_ACCESS_CLIENT_ID";
export const ENV_CLIENT_SECRET = "CF_ACCESS_CLIENT_SECRET";

const JSON_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

export type Credentials = { kind: "service-token"; id: string; secret: string } | { kind: "access-token"; token: string };

/** Both names set, or neither. One without the other can never authenticate, so say so. */
export function serviceTokenFromEnv(): Credentials | undefined {
  let env: Record<string, string>;
  try {
    env = effectiveEnv();
  } catch (err) {
    return fail(io(`cannot read the filmkit vault: ${(err as Error).message}`));
  }
  const id = env[ENV_CLIENT_ID];
  const secret = env[ENV_CLIENT_SECRET];
  if (!id && !secret) return undefined;
  if (!id || !secret) {
    return fail(invalid(`${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} must be set together`, { hint: `one of them is missing; set both (filmkit vault set ${ENV_CLIENT_ID} / ${ENV_CLIENT_SECRET})` }));
  }
  return { kind: "service-token", id, secret };
}

/**
 * The signed-in user's Access JWT, from `cloudflared access token`. Undefined when
 * cloudflared is not installed or nobody has logged in to this origin yet (it then
 * exits non-zero); never opens a browser, never prints the token.
 */
export function accessTokenFromCloudflared(origin: string): string | undefined {
  const r = spawnSync("cloudflared", ["access", "token", "--app", origin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, env: process.env });
  if (r.error || r.status !== 0) return undefined;
  const token = r.stdout.trim();
  return token === "" ? undefined : token;
}

/** Service token first; else the cloudflared login — but only for https origins (a loopback test server has no Access in front of it). */
export function resolveCredentials(origin: string): Credentials | undefined {
  const serviceToken = serviceTokenFromEnv();
  if (serviceToken) return serviceToken;
  if (!origin.startsWith("https://")) return undefined;
  const token = accessTokenFromCloudflared(origin);
  return token ? { kind: "access-token", token } : undefined;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Credentials only go to https, or to a loopback address (the local acceptance server). */
export function normalizeBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return fail(invalid(`--base is not a URL: ${base}`));
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return fail(invalid(`refusing to talk to ${url.origin}: use https (plain http is only allowed for localhost)`, { field: "--base", hint: "service-token headers must not cross a cleartext connection" }));
  }
  return url.origin;
}

export interface Client {
  exportBundle(project: string, composition: string, revision?: number): Promise<unknown>;
  /** Stream an asset's bytes to `dest`, checking size and sha256 as they arrive; leaves nothing at `dest` on failure. */
  download(project: string, assetId: string, dest: string, expect: { sha256: string; sizeBytes: number }): Promise<void>;
}

export function createClient(base: string, creds: Credentials | undefined): Client {
  const origin = normalizeBase(base);
  const headers: Record<string, string> = !creds
    ? {}
    : creds.kind === "service-token"
      ? { "CF-Access-Client-Id": creds.id, "CF-Access-Client-Secret": creds.secret }
      : { "cf-access-token": creds.token };
  const enc = encodeURIComponent;

  async function get(path: string, accept: string, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${origin}${path}`, { headers: { ...headers, Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : (err as Error).message;
      return fail(toolFailure(`GET ${path} failed: ${why}`, { hint: `is ${origin} reachable?` }));
    }
    if (res.ok) return res;
    await res.body?.cancel();
    // Cloudflare Access answers an unauthenticated API call with a 302 to its login page.
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      const login = `cloudflared access login ${origin}`;
      const hint =
        creds?.kind === "service-token"
          ? `the service token was not accepted, or it is not a member of project ${path.split("/")[3]}; ask the project owner to add it`
          : creds?.kind === "access-token"
            ? `your Cloudflare Access login was not accepted or has expired; run: ${login}`
            : `log in once with \`${login}\` (a designer reading their own projects), or set ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} (a service token the project owner added as a member; filmkit vault set <NAME> stores them)`;
      return fail(missingDependency(`vflow refused the request (HTTP ${res.status}) for ${path}`, { hint }));
    }
    if (res.status === 404) return fail(invalid(`not found: ${path}`, { hint: "check the project, composition, revision and asset ids; a project you may not read also answers 404" }));
    if (res.status < 500) return fail(invalid(`vflow answered HTTP ${res.status} for ${path}`));
    return fail(toolFailure(`vflow answered HTTP ${res.status} for ${path}`));
  }

  return {
    async exportBundle(project, composition, revision) {
      const q = revision === undefined ? "" : `&revision=${revision}`;
      const res = await get(`/v1/projects/${enc(project)}/compositions/${enc(composition)}/export?format=json${q}`, "application/json", JSON_TIMEOUT_MS);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return fail(toolFailure("the export response was not JSON", { hint: "is --base really a vflow origin?" }));
      }
      return body;
    },

    async download(project, assetId, dest, expect) {
      const res = await get(`/v1/projects/${enc(project)}/assets/${enc(assetId)}/content`, "*/*", DOWNLOAD_TIMEOUT_MS);
      if (!res.body) return fail(toolFailure(`asset ${assetId}: empty response`));
      const hash = createHash("sha256");
      let size = 0;
      let file: FileHandle | undefined;
      try {
        file = await open(dest, "w");
        // An explicit reader loop, not `for await (… of res.body)`: Bun 1.3.x's native async
        // iterator throws "undefined is not a function" on some bodies (found by CI).
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          size += value.byteLength;
          await file.write(value);
        }
        await file.close();
        file = undefined;
      } catch (err) {
        await file?.close().catch(() => {});
        await rm(dest, { force: true });
        return fail(toolFailure(`asset ${assetId}: download interrupted: ${(err as Error).message}`));
      }
      const got = hash.digest("hex");
      if (size !== expect.sizeBytes || got !== expect.sha256) {
        await rm(dest, { force: true });
        return fail(
          toolFailure(`asset ${assetId}: integrity check failed (expected ${expect.sizeBytes} bytes sha256 ${expect.sha256.slice(0, 12)}…, got ${size} bytes sha256 ${got.slice(0, 12)}…)`, {
            hint: "the bytes vflow served do not match its own manifest; nothing was kept",
          }),
        );
      }
    },
  };
}
