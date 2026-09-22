// A stand-in for a video-generation API, used by tests/http.test.ts.
//
// It runs in its **own process** on purpose: `filmkit run` reaches an http task
// through a blocking worker subprocess, and a blocking parent cannot serve
// requests from its own event loop. The shapes mirror the two providers filmkit
// ships Profiles for:
//
//   * Ark / Seedance — async: POST /tasks -> {id}, GET /tasks/<id> until
//     status=succeeded, then content.video_url to download.
//   * Google / Gemini Omni — sync: POST /interactions -> inline base64 bytes.
//
// Knobs are query parameters so a test never has to share state with this process.

const PORT = Number(process.env.STUB_API_PORT ?? 0);
const KEY = process.env.STUB_API_KEY ?? "test-key";
const polls = new Map<string, number>();

// A real (tiny) mp4, so the produce goes through the same ffprobe path as a live
// provider's file. Made once at startup with ffmpeg.
const VIDEO = await (async (): Promise<Uint8Array> => {
  const dir = await Bun.$`mktemp -d`.text();
  const path = `${dir.trim()}/stub.mp4`;
  await Bun.$`ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x102030:s=64x36:r=10 -t 0.5 -c:v libx264 -pix_fmt yuv420p ${path}`.quiet();
  return new Uint8Array(await Bun.file(path).arrayBuffer());
})();

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    const googleKey = req.headers.get("x-goog-api-key");

    if (url.pathname === "/tasks" && req.method === "POST") {
      if (auth !== `Bearer ${KEY}`) return Response.json({ error: { code: "AuthenticationError" } }, { status: 401 });
      const body = (await req.json()) as { model?: string; content?: unknown };
      if (!body.model || !body.content) return Response.json({ error: { code: "InvalidParameter" } }, { status: 400 });
      const id = `cgt-${Math.random().toString(36).slice(2, 8)}`;
      polls.set(id, 0);
      return Response.json({ id });
    }

    if (url.pathname.startsWith("/tasks/") && req.method === "GET") {
      if (auth !== `Bearer ${KEY}`) return Response.json({ error: { code: "AuthenticationError" } }, { status: 401 });
      const id = url.pathname.split("/")[2]!;
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      const want = Number(url.searchParams.get("polls") ?? 1);
      if (url.searchParams.get("fail") === "1" && n >= want) {
        return Response.json({ id, status: "failed", error: { code: "OutputVideoSensitiveContentDetected", message: "the output video may contain sensitive information" } });
      }
      if (n < want) return Response.json({ id, status: n === 1 ? "queued" : "running" });
      return Response.json({ id, status: "succeeded", content: { video_url: `http://127.0.0.1:${server.port}/file.mp4` }, usage: { total_tokens: 12 } });
    }

    if (url.pathname === "/file.mp4") {
      if (auth !== `Bearer ${KEY}`) return new Response("forbidden", { status: 403 });
      return new Response(Buffer.from(VIDEO), { headers: { "content-type": "video/mp4" } });
    }

    if (url.pathname === "/interactions" && req.method === "POST") {
      if (googleKey !== KEY) return Response.json({ error: { message: "API key not valid" } }, { status: 401 });
      const body = (await req.json()) as { input?: unknown };
      if (!body.input) return Response.json({ error: { message: "input is required" } }, { status: 400 });
      if (url.searchParams.get("mode") === "missing-path") {
        return Response.json({ id: "i-1", status: "completed", steps: [{ type: "model_output", content: [] }] });
      }
      const data = Buffer.from(VIDEO).toString("base64");
      return Response.json({ id: "i-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data }] }] });
    }

    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`stub api on http://127.0.0.1:${server.port}\n`);

export {};
