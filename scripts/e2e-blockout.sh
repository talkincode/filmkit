#!/usr/bin/env bash
# Real end-to-end check of tools/blockout with EVERY tool required: nothing is skipped.
#
# Not part of `bun test` (which exercises the same code but skips, loudly, what is not installed):
# this installs the pinned HyperFrames (network, ~15 s) unless you point BLOCKOUT_HYPERFRAMES at one,
# renders the shipped scene with both engines, measures the results independently with ffprobe/ffmpeg,
# and then runs tests/blockout.test.ts with all gates open and fails if any test was skipped.
#
#   bash scripts/e2e-blockout.sh [workdir]
#
# Requires: bun, ffmpeg, ffprobe, Blender >= 5 (BLOCKOUT_BLENDER or the usual places), node + npm, Chrome.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
SCENE="$REPO_ROOT/tools/blockout/examples/handoff.json"
BO=(bun "$REPO_ROOT/tools/blockout/bin/blockout.ts")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || { printf 'MISSING DEPENDENCY: %s\n' "$1" >&2; exit 3; }; }

for tool in bun ffmpeg ffprobe node npm; do need "$tool"; done

say "HyperFrames (the pinned version, outside the repo)"
PIN="$(sed -n 's/.*HYPERFRAMES_PIN = "\(.*\)";/\1/p' "$REPO_ROOT/tools/blockout/src/version.ts")"
if [ -z "${BLOCKOUT_HYPERFRAMES:-}" ]; then
  mkdir -p "$WORK/hf"
  printf '{ "name": "blockout-e2e-hf", "private": true, "version": "1.0.0", "dependencies": { "hyperframes": "%s" } }\n' "$PIN" > "$WORK/hf/package.json"
  (cd "$WORK/hf" && npm install --no-audit --no-fund >/dev/null 2>&1) || fail "npm install hyperframes@$PIN"
  export BLOCKOUT_HYPERFRAMES="$WORK/hf/node_modules/.bin/hyperframes"
fi
echo "hyperframes: $BLOCKOUT_HYPERFRAMES"

say "doctor: both engines must be ready"
"${BO[@]}" doctor --json > "$WORK/doctor.json" || { cat "$WORK/doctor.json"; fail "blockout doctor is not ready (exit 3 = a missing tool, see above)"; }
bun -e 'const d = JSON.parse(await Bun.file(process.argv[1]).text()); for (const c of d.checks) console.log((c.ok ? "ok  " : "FAIL"), c.name, "-", c.detail); if (!d.ready) process.exit(1)' "$WORK/doctor.json"
BLENDER_BIN="$(bun -e 'const d = JSON.parse(await Bun.file(process.argv[1]).text()); console.log(d.checks.find((c) => c.name === "blender").detail.split(" at ")[1])' "$WORK/doctor.json")"
export BLOCKOUT_TEST_BLENDER="$BLENDER_BIN"

say "validate (declaration, with the complete hand-off binding), then each engine validating its own native project"
"${BO[@]}" validate "$SCENE" --handoff
"${BO[@]}" validate "$SCENE" --engine blender --native
"${BO[@]}" validate "$SCENE" --engine three --native

say "check: contact / occlusion / attachment facts"
"${BO[@]}" check "$SCENE" --strict >/dev/null

for ENGINE in blender three; do
  OUT="$WORK/out/$ENGINE"
  say "render --engine $ENGINE"
  "${BO[@]}" render "$SCENE" --engine "$ENGINE" --out "$OUT"

  say "independent measurement of $ENGINE (ffprobe, not the tool's own report)"
  FACTS="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,r_frame_rate,width,height,codec_name,pix_fmt -of csv=p=0 "$OUT/reference.mp4")"
  echo "$FACTS"
  [ "$FACTS" = "h264,640,360,yuv420p,24/1,72" ] || fail "$ENGINE: expected h264,640,360,yuv420p,24/1,72 (got $FACTS)"
  for f in 0000 0008 0026 0055 0071; do [ -s "$OUT/keyframes/kf-$f.png" ] || fail "$ENGINE: keyframes/kf-$f.png missing"; done
  [ -s "$OUT/overview.png" ] || fail "$ENGINE: overview.png missing"
  bun -e '
    const [dir, engine] = process.argv.slice(1);
    const m = JSON.parse(await Bun.file(`${dir}/manifest.json`).text());
    const sha = (b) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    if (m.schema !== "blockout-manifest/v1alpha1") throw new Error("schema");
    if (m.engine.name !== engine) throw new Error("engine");
    if (JSON.stringify(m.purpose.notFor) !== JSON.stringify(["identity", "first-frame"])) throw new Error("purpose");
    if (m.verification.seek.status !== "verified" || m.verification.seek.identical !== true || m.verification.seek.frames.length < 1) throw new Error("seek verification");
    if (!m.handoff.complete || !m.binding.shot || !m.binding.scene || !m.binding.environment.variant) throw new Error("hand-off binding");
    if (!m.binding.subjects.every((s) => s.variant && s.role === "character") || !m.binding.props.every((p) => p.variant && p.role === "prop")) throw new Error("subject/prop binding");
    for (const a of m.artifacts) {
      const bytes = new Uint8Array(await Bun.file(`${dir}/${a.path}`).arrayBuffer());
      if (bytes.length !== a.size || sha(bytes) !== a.sha256) throw new Error(`${a.path}: size/sha256 do not match the manifest`);
    }
    console.log(`manifest ok: ${m.artifacts.length} artifacts, seek ${m.verification.seek.frames.join(",")} identical`);
  ' "$OUT" "$ENGINE"
done

say "replay from the source archive: plain Blender CLI renders frame 26 to the delivered still's pixels"
mkdir -p "$WORK/replay" && tar xzf "$WORK/out/blender/source.tar.gz" -C "$WORK/replay"
"$BLENDER_BIN" -b "$WORK/replay/source/blender/scene.blend" -o "$WORK/replay/f_####" -f 26 >/dev/null 2>&1
A="$(ffmpeg -v error -i "$WORK/replay/f_0026.png" -f hash -hash sha256 -)"
B="$(ffmpeg -v error -i "$WORK/out/blender/keyframes/kf-0026.png" -f hash -hash sha256 -)"
[ "$A" = "$B" ] || fail "replayed frame differs from the delivered keyframe"
echo "$A"

say "refuses to overwrite; --force replaces; a failure leaves nothing"
if "${BO[@]}" render "$SCENE" --engine blender --out "$WORK/out/blender" >/dev/null 2>&1; then fail "overwrote an existing bundle"; fi
"${BO[@]}" render "$SCENE" --engine blender --out "$WORK/out/blender" --force >/dev/null
BEFORE="$(cd "$WORK/out/blender" && find . | sort)"
if "${BO[@]}" render "$SCENE" --engine blender --out "$WORK/out/blender" --force --blender /no/such/Blender >/dev/null 2>&1; then fail "a missing Blender did not fail"; fi
[ "$BEFORE" = "$(cd "$WORK/out/blender" && find . | sort)" ] || fail "a failed --force changed the bundle"

say "bun test tests/blockout.test.ts with every gate open (none may be skipped)"
(cd "$REPO_ROOT" && bun test tests/blockout.test.ts 2>&1 | tee "$WORK/bun-test.log" | tail -8)
if grep -q '^(skip)' "$WORK/bun-test.log" || grep -q 'NOT RUN' "$WORK/bun-test.log"; then fail "some tests were skipped (see $WORK/bun-test.log)"; fi
grep -q ' 0 fail' "$WORK/bun-test.log" || fail "tests failed (see $WORK/bun-test.log)"

say "OK — outputs in $WORK/out"
