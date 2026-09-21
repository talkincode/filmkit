// Shared test scaffolding: temp projects, real media made by ffmpeg, and a
// CLI runner. Tests exercise the real commands end to end (AGENTS.md §5).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { main, type CliResult } from "../src/cli.ts";

export interface Project {
  dir: string;
  write(rel: string, text: string): void;
  path(rel: string): string;
  cli(...args: string[]): CliResult;
  json<T = unknown>(...args: string[]): { exitCode: number; out: T | undefined; err: { errors: { code: string; message: string; field?: string; line?: number }[] } | undefined };
  cleanup(): void;
}

export function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), "filmkit-test-"));
  const p: Project = {
    dir,
    write(rel, text) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text, "utf8");
    },
    path: (rel) => join(dir, rel),
    cli(...args) {
      const prev = process.cwd();
      process.chdir(dir);
      try {
        return main(args);
      } finally {
        process.chdir(prev);
      }
    },
    json(...args) {
      const r = p.cli(...args, "--json");
      return {
        exitCode: r.exitCode,
        out: r.stdout ? (JSON.parse(r.stdout) as never) : undefined,
        err: r.stderr ? (JSON.parse(r.stderr) as never) : undefined,
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return p;
}

/** Real media via ffmpeg so probes and builds are exercised for real. */
export const media = {
  png(path: string, w = 64, h = 36, color = "0x336699") {
    ff(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-frames:v", "1", path]);
  },
  /** Silent-free test tone; mono 22050 so normalization has real work to do. */
  wav(path: string, seconds: number, freq = 440) {
    ff(["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}:sample_rate=22050`, "-ac", "1", path]);
  },
  /** Odd-sized 24fps clip, optionally with its own audio track. */
  mp4(path: string, seconds: number, opts: { audio?: boolean; w?: number; h?: number } = {}) {
    const args = ["-f", "lavfi", "-i", `testsrc2=size=${opts.w ?? 320}x${opts.h ?? 180}:rate=24:duration=${seconds}`];
    if (opts.audio) args.push("-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-shortest", "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path);
    ff(args);
  },
};

function ff(args: string[]): void {
  mkdirSync(dirname(args[args.length - 1]!), { recursive: true });
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`test fixture ffmpeg failed: ${r.stderr}`);
}

export function probe(path: string): { duration: number; width?: number; height?: number; fps?: number; sampleRate?: number; channels?: number; vcodec?: string; acodec?: string; format?: string } {
  const r = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" });
  const j = JSON.parse(r.stdout) as { format: { duration: string; format_name: string }; streams: Record<string, string | number>[] };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const [n, d] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(j.format.duration),
    width: v?.width as number | undefined,
    height: v?.height as number | undefined,
    fps: d ? n! / d : undefined,
    sampleRate: a ? Number(a.sample_rate) : undefined,
    channels: a?.channels as number | undefined,
    vcodec: v?.codec_name as string | undefined,
    acodec: a?.codec_name as string | undefined,
    format: j.format.format_name,
  };
}

/** A film using only builtin profiles; callers splice scenes/tracks/assets in. */
export function film(parts: { scenes: string; tracks?: string; assets?: string; output?: string; extra?: string }): string {
  return `apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: t }
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
${parts.assets ? `assets:\n${parts.assets}` : ""}
output:
${parts.output ?? `  container: mp4
  video: { width: 320, height: 180, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }`}
scenes:
${parts.scenes}
${parts.tracks ? `timeline:\n  tracks:\n${parts.tracks}` : ""}
${parts.extra ?? ""}
`;
}

/** Put a fake `ffmpeg` first on PATH that fails; returns a restore fn. */
export function breakFfmpeg(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "filmkit-fakebin-"));
  writeFileSync(join(dir, "ffmpeg"), "#!/bin/sh\necho 'simulated ffmpeg crash' >&2\nexit 187\n", { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return () => {
    process.env.PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  };
}
