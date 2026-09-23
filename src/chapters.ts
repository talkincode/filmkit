// Chapter marks (spec §1.8.3): resolve `timeline.chapters` against the derived
// timeline, validate them, and render the deterministic ffmetadata file that
// `build` feeds to ffmpeg with `-map_chapters`.

import { invalid, type ErrorDetail } from "./errors.ts";
import type { DerivedTimeline } from "./timeline.ts";
import type { Film } from "./types.ts";

export const CHAPTERS_PATH = "build/chapters.txt";

export interface ResolvedChapter {
  title: string;
  /** Seconds, millisecond precision. */
  start: number;
  end: number;
}

/** Resolve chapters to absolute [start, end) windows. Returns the errors instead
 *  of throwing so callers with an ErrorCollector (timeline derivation) and
 *  callers without one (build) share the same rule. */
export function resolveChapters(film: Film, timeline: DerivedTimeline): { chapters: ResolvedChapter[]; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const declared = film.timeline.chapters ?? [];
  if (declared.length === 0) return { chapters: [], errors };
  const byId = new Map(timeline.scenes.map((p) => [p.scene.id, p]));
  const starts: { title: string; start: number; field: string }[] = [];
  declared.forEach((c, i) => {
    const field = `timeline.chapters[${i}]`;
    let start: number | undefined;
    if (c.scene !== undefined) {
      const placed = byId.get(c.scene);
      if (!placed) {
        errors.push(invalid(`unknown scene "${c.scene}"`, { field: `${field}.scene` }));
        return;
      }
      start = placed.start;
    } else {
      start = c.start!;
    }
    start = Math.round(start * 1000) / 1000;
    if (start >= timeline.total) {
      errors.push(invalid(`chapter "${c.title}" starts at ${start}s, beyond the total duration ${timeline.total}s`, { field }));
      return;
    }
    starts.push({ title: c.title, start, field });
  });
  if (errors.length) return { chapters: [], errors };
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]!.start <= starts[i - 1]!.start) {
      errors.push(
        invalid(`chapter "${starts[i]!.title}" at ${starts[i]!.start}s does not come after "${starts[i - 1]!.title}" at ${starts[i - 1]!.start}s; list chapters in time order`, {
          field: starts[i]!.field,
        }),
      );
    }
  }
  if (errors.length) return { chapters: [], errors };
  return {
    chapters: starts.map((s, i) => ({ title: s.title, start: s.start, end: i + 1 < starts.length ? starts[i + 1]!.start : timeline.total })),
    errors,
  };
}

/** ffmetadata text for ffmpeg's `-i` + `-map_chapters`. Deterministic: chapter
 *  times are millisecond integers, titles are escaped, no timestamps. */
export function formatChaptersFile(chapters: ResolvedChapter[]): string {
  const lines = [";FFMETADATA1"];
  for (const c of chapters) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${Math.round(c.start * 1000)}`,
      `END=${Math.round(c.end * 1000)}`,
      `title=${escapeValue(c.title)}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** ffmetadata escaping: backslash escapes `= ; #` and itself; newlines cannot
 *  appear in a value, so they become spaces (deterministic, documented). */
export function escapeValue(title: string): string {
  return title
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;")
    .replace(/#/g, "\\#");
}
