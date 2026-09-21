#!/usr/bin/env bash
# Real end-to-end check of the HyperFrames integration against the actual CLI.
#
# Not part of `bun test`: it installs hyperframes (~1 min, network) and renders
# with headless Chrome. Run it when touching profiles/hyperframes.yaml or the
# cwd / healthcheckExpect machinery.
#
#   bash scripts/e2e-hyperframes.sh [workdir] [--narration]
#
# Asserts: the structural pass is clean, the project gate (`hyperframes check`)
# runs inside the project, the render honours the film's geometry via normalize,
# the composed film meets `output`, and editing the composition marks the scene
# stale while a variables change re-renders.
#
# `--narration` additionally exercises text -> speech -> transcript -> .srt ->
# composed film. That needs local models: a Python venv with kokoro-onnx and
# soundfile (point HYPERFRAMES_PYTHON at it, or let this script create one), and
# whisper-cpp for transcription. For Chinese narration pass a multilingual
# whisper model (`model: large-v3`): the default `small.en` is English-only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
NARRATION=false
for arg in "$@"; do [ "$arg" = "--narration" ] && NARRATION=true; done
FILM="$WORK/film"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$FILM/profiles" "$FILM/video/vars" "$FILM/assets"
cp "$REPO_ROOT/profiles/hyperframes.yaml" "$FILM/profiles/"

say "HyperFrames project in $FILM/video"
cat > "$FILM/video/package.json" <<'JSON'
{ "name": "filmkit-hf-e2e", "private": true, "version": "1.0.0", "dependencies": { "hyperframes": "0.8.58" } }
JSON
(cd "$FILM/video" && npm install --no-audit --no-fund >/dev/null 2>&1) || fail "npm install hyperframes"
cat > "$FILM/video/index.html" <<'HTML'
<!doctype html>
<html lang="en" data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"filmkit e2e"}]'>
  <head>
    <meta charset="UTF-8" />
    <title>filmkit × HyperFrames</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #0b0f14; color: #fff; font-family: Inter, system-ui, sans-serif; }
      #root { position: relative; width: 640px; height: 360px; overflow: hidden; }
      .clip { position: absolute; inset: 0; display: grid; place-items: center; }
      h1 { margin: 0; font-size: 44px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="640" data-height="360" data-duration="3">
      <section id="title-card" class="clip" data-start="0" data-duration="3" data-track-index="1">
        <h1 id="title"></h1>
      </section>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      document.getElementById("title").textContent =
        (window.__hyperframes && window.__hyperframes.getVariables().title) || "filmkit e2e";
      const tl = gsap.timeline({ paused: true });
      tl.from("#title", { y: 40, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.2);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
HTML
echo '{"title":"filmkit × HyperFrames"}' > "$FILM/video/vars/s1.json"

say "Static assets"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x0b1729:s=640x360 -frames:v 1 "$FILM/assets/card.png"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=220:duration=2:sample_rate=44100" -ac 2 "$FILM/assets/bgm.wav"

cat > "$FILM/filmkit.yaml" <<'YAML'
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: hyperframes-e2e, title: "HyperFrames e2e" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/hyperframes.yaml
assets:
  bgm: { kind: audio, uri: ./assets/bgm.wav }
output:
  container: mp4
  video: { width: 640, height: 360, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 44100, channels: 2 }
scenes:
  - id: s1
    duration: 3
    durationPolicy: min
    impl:
      profile: hyperframes
      task: render
      params: { project: ./video, quality: draft, variables: ./video/vars/s1.json }
    produces: { video: ./build/s1.mp4 }
  - id: s2
    duration: 2
    durationPolicy: exact
    transition: { type: crossfade, duration: 0.4 }
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }
timeline:
  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.2, fadeOut: 1 }
YAML

cd "$FILM"
say "structural pass (no delegation, and no render)"
"${FK[@]}" validate --no-delegate

say "full validate — delegates to 'hyperframes check' inside ./video"
"${FK[@]}" validate

say "doctor — asserts on the Chrome check, not on optional features"
"${FK[@]}" doctor >/dev/null || fail "doctor reported a problem"

say "run (real HyperFrames render)"
"${FK[@]}" run s1
[ -s build/s1.mp4 ] || fail "the render produced no file"

say "build"
"${FK[@]}" build
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/hyperframes-e2e.mp4)
echo "composed duration: $dur"
python3 - "$dur" <<'PY' || fail "composed duration wrong"
import sys
d = float(sys.argv[1])
assert abs(d - 4.6) < 0.2, d
PY
spec=$(ffprobe -v error -show_entries stream=codec_name,width,height,sample_rate,channels -of csv=p=0 build/hyperframes-e2e.mp4 | tr '\n' ' ')
echo "composed streams: $spec"
echo "$spec" | grep -q 'h264,640,360' || fail "video spec wrong: $spec"
echo "$spec" | grep -q '44100,2' || fail "audio spec wrong: $spec"

if $NARRATION; then
  say "narration chain: text -> speech -> transcript -> .srt -> film"
  VENV="${HYPERFRAMES_VENV:-$WORK/hfvenv}"
  if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV" >/dev/null 2>&1 || skip "cannot create a venv for kokoro-onnx"
    "$VENV/bin/pip" install -q --upgrade pip >/dev/null 2>&1
    "$VENV/bin/pip" install -q kokoro-onnx soundfile >/dev/null 2>&1 || skip "cannot pip install kokoro-onnx soundfile"
  fi
  export HYPERFRAMES_PYTHON="$VENV/bin/python"

  mkdir -p "$FILM/narr/profiles" "$FILM/narr/assets"
  cp "$REPO_ROOT/profiles/hyperframes.yaml" "$FILM/narr/profiles/"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x0b1729:s=640x360 -frames:v 1 "$FILM/narr/assets/card.png"
  cat > "$FILM/narr/filmkit.yaml" <<'YAML'
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: narr-e2e, title: "narration e2e" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/hyperframes.yaml
assets:
  voice:
    kind: audio
    impl:
      profile: hyperframes
      task: tts
      params: { text: "The corridor was empty that night, except for one light.", voice: af_heart }
    produces: { audio: ./build/voice/s1.wav }
  transcript:
    kind: file
    impl:
      profile: hyperframes
      task: transcribe
      params: { input: ./build/voice/s1.wav, dir: ./build/voice, language: en }
    produces: { file: ./build/voice/transcript.json }
  captions:
    kind: subtitle
    impl:
      profile: hyperframes
      task: subtitles
      params: { transcript: ./build/voice/transcript.json }
    produces: { subtitle: ./build/voice/s1.srt }
output:
  container: mp4
  video: { width: 640, height: 360, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
  background: "0x0b1729"
scenes:
  - id: s1
    duration: 2
    durationPolicy: min
    audio: voice
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }
timeline:
  tracks:
    - { id: subs, kind: subtitles, source: captions, mode: sidecar }
YAML
  # The narration film needs the same hyperframes install (it uses --no-install).
  (cd "$FILM/narr" && ln -sfn ../video/node_modules node_modules && ln -sfn ../video/package.json package.json)
  cd "$FILM/narr"
  "${FK[@]}" validate
  "${FK[@]}" run voice
  "${FK[@]}" run transcript
  "${FK[@]}" run captions
  [ -s build/voice/s1.srt ] || fail "the narration chain produced no .srt"
  echo "--- transcribed captions ---"; cat build/voice/s1.srt
  "${FK[@]}" build
  nar=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/narr-e2e.mp4)
  python3 - "$nar" <<'PY2' || fail "composed narration film has the wrong duration"
import sys
d = float(sys.argv[1]); assert 2.0 <= d <= 8.0, d
PY2
  "${FK[@]}" status | tail -1
  cd "$FILM"
fi

say "staleness follows the composition and the variables file"
"${FK[@]}" plan | grep -q 'nothing to do' || fail "expected an up-to-date plan right after build"
before=$(shasum -a 256 build/s1.mp4 | cut -c1-16)
printf '\n<!-- touched -->\n' >> video/index.html
"${FK[@]}" plan | grep -q 's1 \[stale\]' || fail "editing the composition did not mark the scene stale"
echo '{"title":"second take"}' > video/vars/s1.json
"${FK[@]}" run s1 >/dev/null
after=$(shasum -a 256 build/s1.mp4 | cut -c1-16)
[ "$before" != "$after" ] || fail "changing the variables file did not change the rendered frames"
"${FK[@]}" build >/dev/null
"${FK[@]}" status | tail -1

printf '\n\033[1mOK\033[0m  (%s)\n' "$FILM"
