// Mock ComfyUI HTTP API for runner tests (no GPU, no network beyond 127.0.0.1).
// Endpoints: /system_stats, /object_info/<class>, /prompt, /history/<id>, /interrupt, /free.
// On success it writes a REAL small mp4 into `outputDir` and returns the SaveVideo history shape
// confirmed in M0 F9: outputs[<node>] = { images: [{filename, subfolder, type, metadata:{kind:"video",…}}], animated:[true] }.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type MockMode = "ok" | "fail" | "oom" | "hang" | "crash";

export const DEFAULT_CLASSES = ["MiniMaxH3ReferenceToVideo", "Ref2VAVSAGatePatch", "MiniMaxH3SigmaShift", "SaveVideo"];

export interface MockOptions {
  outputDir: string;
  /** One mode for every prompt, or a per-prompt sequence (the last entry repeats). */
  mode?: MockMode | MockMode[];
  /** Node classes known to /object_info. */
  classes?: string[];
  /** Real mp4 to copy on success (see makeSampleMp4). */
  sampleMp4: string;
}

export interface MockComfy {
  url: string;
  prompts: any[];
  interrupts: number;
  frees: number;
  stop(): void;
}

/** Generate the tiny test clip once (testsrc + sine, 0.5 s) and return its path. */
export async function makeSampleMp4(dir = mkdtempSync(join(tmpdir(), "colab-comfy-sample-"))): Promise<string> {
  const out = join(dir, "sample.mp4");
  const p = Bun.spawn(
    ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=12:duration=0.5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-shortest",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await p.exited) !== 0) throw new Error("ffmpeg failed: " + (await new Response(p.stderr).text()));
  return out;
}

function prefixOf(prompt: any): string {
  for (const node of Object.values<any>(prompt ?? {})) {
    if (typeof node?.inputs?.filename_prefix === "string") return node.inputs.filename_prefix;
  }
  return "ComfyUI";
}

export function startMockComfy(opts: MockOptions): MockComfy {
  const modes = Array.isArray(opts.mode) ? opts.mode : [opts.mode ?? "ok"];
  const classes = new Set(opts.classes ?? DEFAULT_CLASSES);
  const history = new Map<string, any>();
  const hanging = new Set<string>();
  const state: MockComfy = { url: "", prompts: [], interrupts: 0, frees: 0, stop: () => server.stop(true) };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/system_stats") return json({ system: { comfyui_version: "mock" }, devices: [] });
      if (path.startsWith("/object_info/")) {
        const cls = decodeURIComponent(path.slice("/object_info/".length));
        return json(classes.has(cls) ? { [cls]: { input: {}, output: [] } } : {});
      }
      if (path === "/prompt" && req.method === "POST") {
        const body = (await req.json()) as any;
        const index = state.prompts.length;
        state.prompts.push(body.prompt);
        const mode = modes[Math.min(index, modes.length - 1)]!;
        const id = `mock-${index}`;
        if (mode === "ok") {
          const prefix = prefixOf(body.prompt); // e.g. "fk/<key>"
          const sub = dirname(prefix) === "." ? "" : dirname(prefix);
          const filename = `${prefix.split("/").pop()}_00001_.mp4`;
          mkdirSync(join(opts.outputDir, sub), { recursive: true });
          copyFileSync(opts.sampleMp4, join(opts.outputDir, sub, filename));
          history.set(id, {
            status: { status_str: "success", completed: true, messages: [] },
            outputs: {
              "16": {
                images: [{ filename, subfolder: sub, type: "output",
                  metadata: { kind: "video", width: 64, height: 64, duration: 0.5, fps: 12, frame_count: 6 } }],
                animated: [true],
              },
            },
          });
        } else if (mode === "fail" || mode === "oom") {
          const oom = mode === "oom";
          history.set(id, {
            status: {
              status_str: "error", completed: false,
              messages: [["execution_error", {
                exception_type: oom ? "torch.OutOfMemoryError" : "RuntimeError",
                exception_message: oom ? "CUDA out of memory. Tried to allocate 2.00 GiB" : "mock failure",
              }]],
            },
            outputs: {},
          });
        } else if (mode === "hang") {
          hanging.add(id);
        } else if (mode === "crash") {
          setTimeout(() => server.stop(true), 20); // answer this request, then stop responding for good
        }
        return json({ prompt_id: id, number: index, node_errors: {} });
      }
      if (path.startsWith("/history/")) {
        const id = path.slice("/history/".length);
        const entry = history.get(id);
        return json(entry ? { [id]: entry } : {});
      }
      if (path === "/interrupt" && req.method === "POST") {
        state.interrupts++;
        for (const id of hanging) {
          history.set(id, { status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}]] }, outputs: {} });
        }
        hanging.clear();
        return json({});
      }
      if (path === "/free" && req.method === "POST") {
        state.frees++;
        return json({});
      }
      return json({ error: "not found: " + path }, 404);
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  return state;
}
