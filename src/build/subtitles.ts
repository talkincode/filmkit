// SRT merge (spec §5): shift each scene's cues by the scene start, clip to the
// scene window, renumber, sort.

import { FilmkitError, invalid } from "../errors.ts";

export interface Cue {
  start: number; // seconds
  end: number;
  text: string;
}

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export function parseSrt(text: string, file: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i) => !(i === 0 && /^\d+$/.test(l.trim())));
    if (lines.length === 0 || lines.every((l) => l.trim() === "")) continue;
    const timing = lines[0]!.trim();
    const m = /^(\S+)\s+-->\s+(\S+)/.exec(timing);
    if (!m) throw new FilmkitError(invalid(`${file}: malformed SRT timing line "${timing}"`));
    const start = parseTime(m[1]!, file);
    const end = parseTime(m[2]!, file);
    if (end < start) throw new FilmkitError(invalid(`${file}: cue ends before it starts: "${timing}"`));
    cues.push({ start, end, text: lines.slice(1).join("\n").trimEnd() });
  }
  return cues;
}

function parseTime(s: string, file: string): number {
  const m = TIME.exec(s);
  if (!m) throw new FilmkitError(invalid(`${file}: malformed SRT timestamp "${s}"`));
  const ms = Number(m[4]!.padEnd(3, "0"));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

export interface MergeInput {
  sceneId: string;
  cues: Cue[];
  start: number;
  end: number;
}

export interface MergeResult {
  cues: Cue[];
  /** Cues that fell entirely outside their window. */
  dropped: { sceneId: string; cue: Cue }[];
  /** Cues that started inside their window but ran past its end, so they were shortened. */
  clipped: { sceneId: string; cue: Cue; to: number }[];
}

export function mergeCues(inputs: MergeInput[]): MergeResult {
  const out: Cue[] = [];
  const dropped: MergeResult["dropped"] = [];
  const clipped: MergeResult["clipped"] = [];
  for (const inp of inputs) {
    const window = inp.end - inp.start;
    for (const c of inp.cues) {
      if (c.start >= window || c.end <= 0) {
        dropped.push({ sceneId: inp.sceneId, cue: c });
        continue;
      }
      if (c.end > window) clipped.push({ sceneId: inp.sceneId, cue: c, to: round3(inp.end) });
      out.push({ start: round3(inp.start + Math.max(0, c.start)), end: round3(inp.start + Math.min(window, c.end)), text: c.text });
    }
  }
  out.sort((x, y) => x.start - y.start || x.end - y.end);
  return { cues: out, dropped, clipped };
}

export function formatSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join("\n");
}

function fmtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(r).padStart(3, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
