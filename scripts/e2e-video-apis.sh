#!/usr/bin/env bash
# Keyed smoke test for the two video-generation Profiles. It spends real money,
# so it only runs when the keys are present and you ask for it explicitly:
#
#   ARK_API_KEY=... bash scripts/e2e-video-apis.sh seedance
#   GEMINI_API_KEY=... bash scripts/e2e-video-apis.sh gemini-omni
#
# `doctor` is always safe to run: it only reports whether the variable is set.
# The script prints the raw provider response for the fields filmkit could not
# verify from the docs (notably Gemini's inline video path), so a mismatch is
# visible instead of mysterious.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHICH="${1:-}"
WORK="$(mktemp -d)"
FILM="$WORK/film"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
skip() { printf 'SKIP: %s\n' "$*" >&2; exit 0; }

case "$WHICH" in
  seedance)
    [ -n "${ARK_API_KEY:-}" ] || skip "ARK_API_KEY is not set"
    PROFILE=seedance
    PARAMS='{ model: doubao-seedance-1-0-pro-250528, prompt: "a single red paper boat drifting along a rainy gutter, close-up, slow push-in", ratio: "16:9", duration: 5, watermark: false }'
    ;;
  gemini-omni)
    [ -n "${GEMINI_API_KEY:-}" ] || skip "GEMINI_API_KEY is not set"
    PROFILE=gemini-omni
    PARAMS='{ model: gemini-omni-1.1-flash, prompt: "a single red paper boat drifting along a rainy gutter, close-up, slow push-in", aspectRatio: "16:9", resolution: 720p, timeout: 600 }'
    ;;
  *) fail "usage: bash scripts/e2e-video-apis.sh <seedance|gemini-omni>" ;;
esac

mkdir -p "$FILM/profiles"
cp "$REPO_ROOT/profiles/$PROFILE.yaml" "$FILM/profiles/"
cat > "$FILM/filmkit.yaml" <<YAML
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: $PROFILE-e2e, title: "$PROFILE e2e" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/$PROFILE.yaml
output:
  container: mp4
  video: { width: 1280, height: 720, fps: 30, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: s1
    duration: 5
    durationPolicy: min
    impl:
      profile: $PROFILE
      task: text-to-video
      params: $PARAMS
    produces: { video: ./build/s1.mp4 }
YAML

cd "$FILM"
say "doctor (reports the key by name only)"
"${FK[@]}" doctor | tail -3
say "validate + plan"
"${FK[@]}" validate
"${FK[@]}" plan | grep -q 'filmkit run' || fail "plan does not offer to run the generation"

say "run (this costs money)"
if ! "${FK[@]}" run s1; then
  printf '\nThe provider rejected the request or the response shape did not match.\n' >&2
  printf 'Compare the error hint with the profile at profiles/%s.yaml and the API docs.\n' "$PROFILE" >&2
  exit 1
fi
[ -s build/s1.mp4 ] || fail "no video was produced"
say "produced file"
ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height -of compact build/s1.mp4

say "build (compose the film around it)"
"${FK[@]}" build
"${FK[@]}" status | tail -1
printf '\n\033[1mOK\033[0m  (%s)\n' "$FILM"
