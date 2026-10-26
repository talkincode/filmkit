// A stand-in for the two vflow REST endpoints vflow-pull uses, shaped like the real
// ones (the real server is exercised by scripts/e2e-vflow.sh). It runs in this
// process: the tool's fetch is asynchronous, so it can serve from the same event loop.
//
//   GET /v1/projects/:p/compositions/:c/export[?revision=N]  -> { bundle, serialized }
//   GET /v1/projects/:p/assets/:a/content                    -> bytes, ETag "<sha256>"
//
// Without a valid service token or Access login (cf-access-token) it answers like Cloudflare Access does:
// a 302 to a login page. `behavior` lets a test break one thing at a time.
//
// node:http rather than Bun.serve on purpose: a dropped connection has to be a real
// destroyed socket (what a network cut looks like), which Bun.serve cannot express
// without surfacing as an unhandled error in the server itself.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = { id: "svc-test-id", secret: "svc-test-secret-DO-NOT-LEAK", jwt: "stub-access-jwt-DO-NOT-LEAK" };

export interface Behavior {
  /** Serve other bytes than the manifest promises for this asset id. */
  corrupt?: string;
  /** Send half of the body for this asset id, then cut the connection. */
  truncate?: string;
  /** Answer this status for every request. */
  status?: number;
  /** Do not require the token. */
  open?: boolean;
}

export interface Stub {
  url: string;
  behavior: Behavior;
  /** "METHOD path" of every request, in order. */
  requests: string[];
  stop(): void;
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function startStub(opts: { bundle: Record<string, unknown>; assets: Record<string, Uint8Array>; project: string; composition: string }): Promise<Stub> {
  const behavior: Behavior = {};
  const requests: string[] = [];

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (behavior.status) return json(res, behavior.status, { error: "forced" });
    const authed =
      (req.headers["cf-access-client-id"] === TOKEN.id && req.headers["cf-access-client-secret"] === TOKEN.secret) || req.headers["cf-access-token"] === TOKEN.jwt;
    if (!behavior.open && !authed) {
      res.writeHead(302, { location: "https://stub.cloudflareaccess.com/login", connection: "close" });
      return void res.end();
    }

    const exp = new RegExp(`^/v1/projects/${opts.project}/compositions/${opts.composition}/export$`).exec(url.pathname);
    if (exp) {
      const rev = url.searchParams.get("revision");
      if (rev !== null && Number(rev) !== (opts.bundle as { revision?: number }).revision) return json(res, 404, { error: { code: "NOT_FOUND" } });
      return json(res, 200, { bundle: opts.bundle, serialized: JSON.stringify(opts.bundle) });
    }

    const asset = new RegExp(`^/v1/projects/${opts.project}/assets/([^/]+)/content$`).exec(url.pathname);
    if (asset) {
      const id = decodeURIComponent(asset[1]!);
      const bytes = opts.assets[id];
      if (!bytes) return json(res, 404, { error: { code: "NOT_FOUND" } });
      const headers = { "content-type": "application/octet-stream", "content-length": String(bytes.length), etag: `"${sha256(bytes)}"`, connection: "close" };
      if (behavior.truncate === id) {
        res.writeHead(200, headers);
        res.write(bytes.slice(0, Math.floor(bytes.length / 2)));
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      res.writeHead(200, headers);
      return void res.end(behavior.corrupt === id ? Buffer.from(bytes).map((b) => b ^ 0xff) : Buffer.from(bytes));
    }
    json(res, 404, { error: "not found" });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // fixed now: it must stay readable after stop()
  return {
    url,
    behavior,
    requests,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
