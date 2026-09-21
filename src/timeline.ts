// Timeline derivation (spec §2). Pure: takes planned durations, observed
// natural durations and the film, returns start/end per scene plus the checks
// that only make sense once durations are known.

import { ErrorCollector, invalid } from "./errors.ts";
import { at, type LoadedFilm } from "./film.ts";
import { round } from "./probe.ts";
import type { ProjectState } from "./state.ts";
import type { Scene, Transition } from "./types.ts";

export interface PlacedScene {
  scene: Scene;
  index: number;
  start: number;
  end: number;
  duration: number;
  /** Duration came from the plan (produces missing), not from a probe. */
  estimated: boolean;
  /** Incoming transition (cut for the first scene). */
  transition: Transition;
  /** Gap of background colour inserted before this scene by an explicit `start`. */
  gapBefore: number;
  naturalDuration?: number;
}

export interface DerivedTimeline {
  scenes: PlacedScene[];
  total: number;
}

export function sceneDuration(scene: Scene, natural: number | undefined): { duration: number; estimated: boolean } {
  const planned = scene.duration;
  if (natural === undefined) {
    // Nothing with a duration exists yet (or the scene is image-only); the plan is the only source.
    return { duration: planned!, estimated: scene.produces.video !== undefined || scene.produces.audio !== undefined };
  }
  switch (scene.durationPolicy) {
    case "auto":
      return { duration: natural, estimated: false };
    case "exact":
      return { duration: planned!, estimated: false };
    case "min":
      return { duration: Math.max(planned!, natural), estimated: false };
  }
}

export function deriveTimeline(loaded: LoadedFilm, state: ProjectState, errors: ErrorCollector): DerivedTimeline {
  const { film, src } = loaded;
  const byId = new Map(film.scenes.map((s, i) => [s.id, { scene: s, index: i }]));
  const placed: PlacedScene[] = [];
  let cursor = 0;
  film.timeline.sequence.forEach((id, pos) => {
    const entry = byId.get(id);
    if (!entry) return; // reported by loadFilm
    const { scene, index } = entry;
    const natural = state.nodes.get(id)?.naturalDuration;
    const { duration, estimated } = sceneDuration(scene, natural);
    const transition: Transition = pos === 0 ? { type: "cut" } : scene.transition ?? film.timeline.transition.default;
    const t = transition.type === "crossfade" ? transition.duration! : 0;
    let start = round(cursor - t);
    let gapBefore = 0;
    if (pos === 0) start = 0;
    if (scene.start !== undefined) {
      if (scene.start < start - 1e-9) {
        errors.add(
          at(
            invalid(`start ${scene.start} is earlier than the derived ${start} (previous scene end minus transition)`, {
              field: `scenes[${index}].start`,
            }),
            src,
          ),
        );
      } else {
        gapBefore = round(scene.start - start);
        start = scene.start;
        if (gapBefore > 0 && t > 0) {
          errors.add(at(invalid("an explicit start that leaves a gap cannot be combined with a crossfade", { field: `scenes[${index}].start` }), src));
        }
      }
    }
    const prev = placed[placed.length - 1];
    if (t > 0 && prev) {
      if (t >= prev.duration / 2 || t >= duration / 2) {
        errors.add(
          at(
            invalid(`crossfade ${t}s must be shorter than half of both adjacent scenes (${prev.duration}s, ${duration}s)`, {
              field: scene.transition ? `scenes[${index}].transition.duration` : "timeline.transition.default.duration",
            }),
            src,
          ),
        );
      }
    }
    const end = round(start + duration);
    placed.push({ scene, index, start, end, duration: round(duration), estimated, transition, gapBefore, naturalDuration: natural });
    cursor = end;
  });
  const total = placed.length ? placed[placed.length - 1]!.end : 0;

  film.timeline.tracks.forEach((tr, i) => {
    if (tr.kind === "subtitles") return;
    const to = tr.to === "end" ? total : tr.to;
    if (to > total + 1e-9) errors.add(at(invalid(`to=${to} exceeds the total duration ${total}`, { field: `timeline.tracks[${i}].to` }), src));
    if (tr.from >= total && total > 0) errors.add(at(invalid(`from=${tr.from} is at or after the total duration ${total}`, { field: `timeline.tracks[${i}].from` }), src));
    if (tr.kind === "audio" && tr.fadeIn + tr.fadeOut > to - tr.from) {
      errors.add(at(invalid("fadeIn + fadeOut exceed the track's span", { field: `timeline.tracks[${i}].fadeOut` }), src));
    }
  });

  const planned = film.output.duration.planned;
  if (planned !== undefined && placed.every((p) => !p.estimated) && Math.abs(planned - total) > film.output.duration.tolerance) {
    errors.add(
      at(invalid(`derived total ${total}s differs from output.duration.planned ${planned}s by more than tolerance ${film.output.duration.tolerance}s`, { field: "output.duration.planned" }), src),
    );
  }
  return { scenes: placed, total };
}
