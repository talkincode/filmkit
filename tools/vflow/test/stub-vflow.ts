// A stand-in for the two vflow REST endpoints vflow-pull uses, shaped like the real
// ones (the real server is exercised by scripts/e2e-vflow.sh). It runs in this
// process: the tool's fetch is asynchronous, so it can serve from the same event loop.
//
//   GET /v1/projects/:p/compositions/:c/export[?revision=N]  -> { bundle, serialized }
//   GET /v1/projects/:p/assets/:a/content                    -> bytes, ETag "<sha256>"
//
// Without the right service-token headers it answers like Cloudflare Access does:
// a 302 to a login page. `behavior` lets a test break one thing at a time.

import { createHash } from "node:crypto";

export const TOKEN = { id: "svc-test-id", secret: "svc-test-secret-DO-NOT-LEAK" };

export interface Behavior {
  /** Serve other bytes than the manifest promises for this asset id. */
  corrupt?: string;
  /** Send half of the body for this asset id, then drop the connection. */
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
  /** Header names seen on the last request (values are asserted elsewhere to never leak). */
  stop(): void;
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function startStub(opts: { bundle: Record<string, unknown>; assets: Record<string, Uint8Array>; project: string; composition: string }): Stub {
  const behavior: Behavior = {};
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (behavior.status) return new Response("forced", { status: behavior.status });
      const authed = req.headers.get("cf-access-client-id") === TOKEN.id && req.headers.get("cf-access-client-secret") === TOKEN.secret;
      if (!behavior.open && !authed) return new Response(null, { status: 302, headers: { location: "https://stub.cloudflareaccess.com/login" } });

      const exp = new RegExp(`^/v1/projects/${opts.project}/compositions/${opts.composition}/export$`).exec(url.pathname);
      if (exp) {
        const rev = url.searchParams.get("revision");
        if (rev !== null && Number(rev) !== (opts.bundle as { revision?: number }).revision) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
        return Response.json({ bundle: opts.bundle, serialized: JSON.stringify(opts.bundle) });
      }
      const asset = new RegExp(`^/v1/projects/${opts.project}/assets/([^/]+)/content$`).exec(url.pathname);
      if (asset) {
        const id = decodeURIComponent(asset[1]!);
        const bytes = opts.assets[id];
        if (!bytes) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
        if (behavior.corrupt === id) return new Response(new Uint8Array(bytes).map((b) => b ^ 0xff), { headers: { etag: `"${sha256(bytes)}"` } });
        if (behavior.truncate === id) {
          const half = bytes.slice(0, Math.floor(bytes.length / 2));
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(half);
              controller.error(new Error("connection dropped"));
            },
          });
          return new Response(stream, { headers: { "content-length": String(bytes.length) } });
        }
        return new Response(new Uint8Array(bytes), { headers: { etag: `"${sha256(bytes)}"`, "content-type": "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, behavior, requests, stop: () => void server.stop(true) };
}
