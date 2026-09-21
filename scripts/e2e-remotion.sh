#!/usr/bin/env bash
# Real end-to-end check of the Remotion integration against the actual CLI.
#
# Not part of `bun test`: it installs Remotion (~1 min, network) and renders
# 100 frames with headless Chrome. Run it when touching
# profiles/remotion.yaml or the cwd / staleness machinery.
#
#   bash scripts/e2e-remotion.sh [workdir]
#
# It asserts: validate is clean, the render runs inside the Remotion project
# with absolute paths, the output meets `output`, editing the project marks the
# node stale, and changing the props file re-renders different frames.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
FILM="$WORK/film"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$FILM/profiles" "$FILM/video/src" "$FILM/video/props" "$FILM/assets"
cp "$REPO_ROOT/profiles/remotion.yaml" "$FILM/profiles/"

say "Remotion project in $FILM/video"
cat > "$FILM/video/package.json" <<'JSON'
{ "name": "filmkit-e2e-scene", "private": true, "version": "1.0.0",
  "dependencies": { "remotion": "4.0.526", "@remotion/cli": "4.0.526", "react": "19.1.0", "react-dom": "19.1.0" } }
JSON
cat > "$FILM/video/src/index.tsx" <<'TSX'
import React from "react";
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from "remotion";

const Card: React.FC<{ title?: string }> = ({ title = "default" }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#102030", justifyContent: "center", alignItems: "center" }}>
      <div style={{ color: "white", fontFamily: "sans-serif", fontSize: 48, opacity }}>{title}</div>
    </AbsoluteFill>
  );
};

const Root: React.FC = () => (
  <Composition id="SceneOne" component={Card} durationInFrames={100} fps={25} width={640} height={360}
    defaultProps={{ title: "default" }} />
);
registerRoot(Root);
TSX
(cd "$FILM/video" && npm install --no-audit --no-fund >/dev/null 2>&1) || fail "npm install in the Remotion project"
echo '{"title":"filmkit e2e"}' > "$FILM/video/props/s1.json"

say "Static assets"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x0b1729:s=640x360 -frames:v 1 "$FILM/assets/card.png"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=220:duration=3:sample_rate=44100" -ac 2 "$FILM/assets/bgm.wav"

cat > "$FILM/filmkit.yaml" <<'YAML'
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: remotion-e2e, title: "Remotion e2e" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/remotion.yaml
assets:
  bgm: { kind: audio, uri: ./assets/bgm.wav }
output:
  container: mp4
  video: { width: 640, height: 360, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 44100, channels: 2 }
scenes:
  - id: s1
    duration: 4
    durationPolicy: min
    impl:
      profile: remotion
      task: render
      params: { project: ./video, entry: src/index.tsx, composition: SceneOne, props: ./video/props/s1.json, crf: 23 }
    produces: { video: ./build/s1.mp4 }
  - id: s2
    duration: 2.5
    durationPolicy: exact
    transition: { type: crossfade, duration: 0.5 }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }
timeline:
  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2, fadeOut: 1 }
YAML

cd "$FILM"
say "validate + doctor"
"${FK[@]}" validate
"${FK[@]}" doctor >/dev/null || fail "doctor reported a problem"

say "plan"
"${FK[@]}" plan | grep -q 'filmkit run' || fail "plan does not offer filmkit run for the Remotion scene"

say "run (real Remotion render)"
"${FK[@]}" run s1
[ -s build/s1.mp4 ] || fail "the render produced no file"

say "build"
"${FK[@]}" build
probe=$(ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height,sample_rate,channels -of csv=p=0 build/remotion-e2e.mp4)
echo "$probe"
echo "$probe" | grep -q '640,360' || fail "composed width/height wrong: $probe"
echo "$probe" | grep -q '44100,2' || fail "composed audio spec wrong: $probe"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/remotion-e2e.mp4)
python3 - "$dur" <<'PY' || fail "composed duration wrong"
import sys
d = float(sys.argv[1])
assert abs(d - 6.0) < 0.2, d
PY

say "staleness follows the project and the props file"
"${FK[@]}" plan | grep -q 'nothing to do' || fail "expected an up-to-date plan right after build"
before=$(shasum -a 256 build/s1.mp4 | cut -c1-16)
printf '\n// touched\n' >> video/src/index.tsx
"${FK[@]}" plan | grep -q 's1 \[stale\]' || fail "editing the Remotion project did not mark the scene stale"
python3 -c "import json;p='video/props/s1.json';d=json.load(open(p));d['title']='second take';json.dump(d,open(p,'w'))"
"${FK[@]}" run s1 >/dev/null
after=$(shasum -a 256 build/s1.mp4 | cut -c1-16)
[ "$before" != "$after" ] || fail "changing the props file did not change the rendered frames"
"${FK[@]}" build >/dev/null
"${FK[@]}" status | tail -1

printf '\n\033[1mOK\033[0m  (%s)\n' "$FILM"
