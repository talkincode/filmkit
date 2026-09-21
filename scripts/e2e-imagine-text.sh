#!/usr/bin/env bash
# Text cards without ffmpeg's drawtext: a real `imagine text render` (which needs
# a resvg-enabled build) produces the card PNGs, filmkit composites them.
#
#   bash scripts/e2e-imagine-text.sh [workdir] [--build]
#
# `--build` clones and builds imagine with -Dsvg-overlay=true (needs Zig >= 0.16
# and libresvg; on macOS: `brew install zig resvg`). Without it the script uses
# `imagine` from PATH and skips when that binary lacks SVG support.
#
# Asserts: the CJK card and the lower-third overlay render, the card scene sits
# on output.background (not black), the overlay window reaches the filtergraph,
# and the composed film meets `output`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"; shift || true
BUILD_IMAGINE=false
for arg in "$@"; do [ "$arg" = "--build" ] && BUILD_IMAGINE=true; done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
skip() { printf 'SKIP: %s\n' "$*" >&2; exit 0; }

BIN_DIR="$WORK/bin"; mkdir -p "$BIN_DIR"

if $BUILD_IMAGINE; then
  say "Building imagine with resvg support"
  command -v zig >/dev/null || skip "zig is not installed (brew install zig)"
  SRC="$WORK/imagine-src"
  [ -d "$SRC" ] || git clone --depth 1 https://github.com/talkincode/imagine.git "$SRC" >/dev/null 2>&1 || skip "cannot clone imagine"
  (cd "$SRC" && zig build -Dsvg-overlay=true -Dresvg-include=/opt/homebrew/include -Dresvg-lib=/opt/homebrew/lib -Doptimize=ReleaseSafe) \
    || skip "zig build failed (is libresvg installed? brew install resvg)"
  cp "$SRC/zig-out/bin/imagine" "$BIN_DIR/imagine"
fi
export PATH="$BIN_DIR:$PATH"

say "Checking the imagine build"
command -v imagine >/dev/null || skip "imagine is not installed"
imagine version || fail "imagine version"
if ! imagine text render --text "probe" -o "$WORK/probe.png" --width 64 >/dev/null 2>&1; then
  skip "this imagine build has no SVG/resvg support; rerun with --build (needs zig + libresvg)"
fi

FILM="$WORK/film"
mkdir -p "$FILM/profiles"
cp "$REPO_ROOT/profiles/imagine.yaml" "$FILM/profiles/"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=25:duration=3" -c:v libx264 -pix_fmt yuv420p -preset ultrafast "$FILM/clip.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=220:duration=2:sample_rate=44100" -ac 2 "$FILM/bgm.wav"

cat > "$FILM/filmkit.yaml" <<'YAML'
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: text-cards, title: "imagine text × filmkit" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/imagine.yaml
assets:
  bgm: { kind: audio, uri: ./bgm.wav }
  lower-third:
    kind: image
    impl:
      profile: imagine
      task: text
      params:
        text: "源头，是内鬼｜第 2 集"
        width: 640
        font: PingFang SC
        size: 34
        color: "#ffe9a8"
        stroke: "#000000"
        strokeWidth: 2
        align: left
        padding: 12
    produces: { image: ./build/txt/lower-third.png }
output:
  container: mp4
  video: { width: 640, height: 360, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 44100, channels: 2 }
  background: "0x0b1729"
scenes:
  - id: s1
    duration: 3
    durationPolicy: exact
    impl: { profile: filmkit/static, task: clip }
    produces: { video: ./clip.mp4 }
  - id: card
    duration: 2.5
    durationPolicy: exact
    transition: { type: crossfade, duration: 0.5 }
    impl:
      profile: imagine
      task: text
      params:
        text: "深夜律所走廊\n源头，是内鬼"
        width: 640
        font: PingFang SC
        size: 52
        color: "#ffffff"
        stroke: "#0b1729"
        strokeWidth: 3
        align: center
        lineHeight: 1.5
        padding: 24
    produces: { image: ./build/txt/card.png }
timeline:
  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2, fadeOut: 1 }
    - { id: lower, kind: overlay, asset: lower-third, position: bottom-left, margin: 24, width: 520, opacity: 0.95, from: 0.4, to: 4.8 }
YAML

cd "$FILM"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")
say "validate + plan"
"${FK[@]}" validate
"${FK[@]}" plan | grep -q 'imagine' || fail "plan does not list the text nodes"

say "generate the text PNGs (real imagine text render)"
"${FK[@]}" run lower-third
"${FK[@]}" run card
for f in build/txt/lower-third.png build/txt/card.png; do
  [ -s "$f" ] || fail "$f was not produced"
  fmt=$(ffprobe -v error -show_entries stream=pix_fmt -of csv=p=0 "$f")
  echo "$f pix_fmt=$fmt"
  echo "$fmt" | grep -qi rgba || fail "$f is not an alpha PNG (got $fmt)"
done

say "build + verify"
"${FK[@]}" build
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/text-cards.mp4)
python3 - "$dur" <<'PY' || fail "composed duration wrong"
import sys
d = float(sys.argv[1]); assert abs(d - 5.0) < 0.2, d
PY
pixel() { ffmpeg -v error -ss "$3" -i "$1" -vf "crop=1:1:$2,format=rgb24" -frames:v 1 -f rawvideo - | od -An -tu1 | tr -s ' '; }
corner=$(pixel build/text-cards.mp4 "4:4" 4)
echo "card corner rgb:$corner (film background 0x0b1729 = 11 23 41, encoded lossily)"
python3 - "$corner" <<'PY' || fail "transparent card did not composite onto output.background"
import sys
r, g, b = [int(x) for x in sys.argv[1].split()]
assert abs(r - 11) <= 12 and abs(g - 23) <= 12 and abs(b - 41) <= 12, (r, g, b)
PY
grep -q "enable='between(t\\\\,0.4\\\\,4.8)'" build/compose.filtergraph.txt || fail "overlay window missing from the filtergraph"
"${FK[@]}" status | tail -1

printf '\n\033[1mOK\033[0m  (%s)\n' "$FILM"
printf 'card frame: ffmpeg -ss 4 -i %s/build/text-cards.mp4 -frames:v 1 card.png\n' "$FILM"
