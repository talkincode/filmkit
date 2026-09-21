// `filmkit/cues-v1` segment boundaries and the `fit: exact` cadence check
// (docs/spec.md §1.8.2, §7). filmkit never reads a tool's own timing document
// (scorekit meta.json, HyperFrames project, …); a producer that knows exact
// segment lengths writes this neutral file instead.

import { FilmkitError, invalid, type ErrorDetail } from "./errors.ts";
import { validateAgainstSchema } from "./schema.ts";
import type { DerivedTimeline } from "./timeline.ts";
import type { AudioTrack, Film } from "./types.ts";
import { loadYamlFile, positionOf } from "./yaml.ts";

export const CUE_VERSION = "filmkit/cues-v1";

export interface CueEntry {
  id?: string;
  label?: string;
  /** Seconds relative to the audio file's own start. */
  start: number;
  end: number;
}

export interface CueFile {
  version: typeof CUE_VERSION;
  cues: CueEntry[];
}

/** Default alignment tolerance for `fit: exact`, in seconds (one frame at 25fps is 0.04). */
export const DEFAULT_CUE_TOLERANCE = 0.05;

/** Parse a cue file. JSON is a subset of YAML, so the shared YAML loader reads it. */
export function loadCueFile(path: string): CueFile {
  const src = loadYamlFile(path);
  validateAgainstSchema("cues", src);
  const file = src.value as CueFile;
  const errors: ErrorDetail[] = [];
  let prev = -Infinity;
  file.cues.forEach((c, i) => {
    const at = (k: string) => positionOf(src, ["cues", i, k]);
    if (c.end <= c.start) {
      errors.push(invalid(`${path}: cues[${i}] ends before it starts`, { field: `cues[${i}].end`, ...at("end") }));
    }
    if (c.start < prev - 1e-9) {
      errors.push(invalid(`${path}: cues[${i}] starts before the previous cue ended (overlap or out of order)`, { field: `cues[${i}].start`, ...at("start") }));
    }
    prev = c.end;
  });
  if (errors.length) throw new FilmkitError(errors);
  return file;
}

/** Absolute film seconds where the picture cuts: scene starts (crossfade midpoint) plus the film end. */
export function cutPoints(timeline: DerivedTimeline): number[] {
  const points: number[] = [];
  timeline.scenes.forEach((p, i) => {
    const t = p.transition.type === "crossfade" ? p.transition.duration! : 0;
    points.push(i === 0 ? 0 : round(p.start + t / 2));
  });
  points.push(timeline.total);
  return points;
}

export interface ExactTrack {
  /** Index in `timeline.tracks`, for error fields. */
  index: number;
  track: AudioTrack;
  /** Absolute film seconds where the music starts. */
  from: number;
  /** Length the music must cover, in seconds. */
  span: number;
  tolerance: number;
  /** Path (relative to the project) of the `filmkit/cues-v1` file. */
  cuesPath: string;
}

/** Every `fit: exact` track with its resolved span. Tracks without a cues declaration are skipped (validate reports those). */
export function exactTracks(film: Film, total: number): ExactTrack[] {
  const out: ExactTrack[] = [];
  film.timeline.tracks.forEach((t, index) => {
    if (t.kind !== "audio" || t.fit !== "exact" || !t.cues) return;
    const to = t.to === "end" ? total : t.to;
    out.push({ index, track: t, from: t.from, span: round(to - t.from), tolerance: t.tolerance ?? DEFAULT_CUE_TOLERANCE, cuesPath: t.cues });
  });
  return out;
}

/**
 * Verify that every internal cue boundary of a `fit: exact` track lands on a
 * picture cut, and that the music covers the span it was asked to cover.
 * The caller decides whether the cue file exists (a not-yet-produced asset is
 * `plan`'s business, not an error here).
 */
export function checkExactTrack(spec: ExactTrack, timeline: DerivedTimeline, dir: string): ErrorDetail[] {
  const field = `timeline.tracks[${spec.index}].tolerance`;
  const file = loadCueFile(`${dir}/${spec.cuesPath}`);
  const cuts = cutPoints(timeline);
  const errors: ErrorDetail[] = [];
  const nearest = (t: number) => cuts.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best), cuts[0]!);

  file.cues.forEach((cue, i) => {
    if (i === 0) return; // the music's own start anchors to the track start, not to a cut
    const at = round(spec.from + cue.start);
    const cut = nearest(at);
    if (Math.abs(cut - at) > spec.tolerance) {
      errors.push(
        invalid(
          `cue boundary "${cue.id ?? `cues[${i}]`}" lands at ${at}s but the nearest picture cut is ${cut}s (off by ${round(Math.abs(cut - at))}s > tolerance ${spec.tolerance}s)`,
          { field, hint: "rebuild the music so its segments match the scene lengths, or adjust the scene durations" },
        ),
      );
    }
  });

  const musicEnd = round(spec.from + file.cues[file.cues.length - 1]!.end);
  const spanEnd = round(spec.from + spec.span);
  if (musicEnd < spanEnd - spec.tolerance) {
    errors.push(
      invalid(`music ends at ${musicEnd}s but must cover ${spanEnd}s (short by ${round(spanEnd - musicEnd)}s > tolerance ${spec.tolerance}s)`, {
        field,
        hint: "`fit: exact` neither loops nor pads; lengthen the piece or switch the track to `fit: loop`",
      }),
    );
  }
  return errors;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
