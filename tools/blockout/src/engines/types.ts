export interface SeekCheck {
  /** "verified": frames were rendered out of order and compared. "skipped": --seek-samples 0, nothing was checked and nothing is claimed. */
  status: "verified" | "skipped";
  /** Frames visited, in the order they were visited (deliberately not ascending). Empty when skipped. */
  frames: number[];
  /** Pixels match on checked frames; null means the check was explicitly skipped. */
  identical: boolean | null;
  method: string;
  /** Blender also compares every object's world pose with the evaluator's; the worst deviation. */
  stateMaxError?: number;
}

export interface EngineRender {
  name: "blender" | "three";
  /** The engine's own version: Blender's, or the pinned Three.js. */
  version: string;
  renderer: string;
  pins: Record<string, string>;
  /** Frame `f` (0-based) of the sequential render. */
  framePath(f: number): string;
  /** First frame number in the sequence's file names (Blender 0, HyperFrames 1), plus a printf pattern, for ffmpeg. */
  sequence: { pattern: string; startNumber: number };
  overviewPath: string;
  seek: SeekCheck;
}

export const SEEK_SKIPPED: SeekCheck = {
  status: "skipped",
  frames: [],
  identical: null,
  method: "skipped (--seek-samples 0); not verified: no random-access check was performed",
};

/** The same frames every run, but not 0..N-1: a fixed pseudo-random shuffle seeded by the declaration's hash. */
export function seekFrames(seedHex: string, total: number, count: number): number[] {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  const rnd = () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = Array.from({ length: total }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked = pool.slice(0, Math.min(count, total));
  // "out of order" must hold even when the shuffle happens to land ascending
  if (picked.length > 1 && picked.every((f, i) => i === 0 || f > picked[i - 1]!)) picked.reverse();
  return picked;
}
