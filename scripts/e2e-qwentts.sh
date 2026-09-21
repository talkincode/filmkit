#!/usr/bin/env bash
# Real end-to-end check of the qwentts Profile: local Qwen3-TTS narration drives
# a scene's length, and the film builds around it.
#
#   bash scripts/e2e-qwentts.sh [workdir]
#
# Needs: qwen3-tts-ai on PATH (or QWEN3_TTS pointing at the script) and its model
# weights under ~/mlx-audio-qwen3-tts/models. Skips with instructions otherwise —
# no weights are downloaded here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
FILM="$WORK/film"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
skip() { printf 'SKIP: %s\n' "$*" >&2; exit 0; }

BIN="${QWEN3_TTS:-}"
if [ -z "$BIN" ]; then
  command -v qwen3-tts-ai >/dev/null || skip "qwen3-tts-ai is not on PATH (symlink it from the qwentts repo, or set QWEN3_TTS)"
  BIN="$(command -v qwen3-tts-ai)"
fi
[ -x "$BIN" ] || skip "$BIN is not executable"
"$BIN" --print-models >/dev/null 2>&1 || skip "$BIN does not run"
"$BIN" --help 2>&1 | grep -q -- '--emotion-intensity' || skip "$BIN is older than the released CLI (no --emotion-intensity); re-symlink the repo script"

mkdir -p "$FILM/profiles" "$FILM/assets" "$FILM/bin"
cp "$REPO_ROOT/profiles/qwentts.yaml" "$FILM/profiles/"
ln -sf "$BIN" "$FILM/bin/qwen3-tts-ai"
export PATH="$FILM/bin:$PATH"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x0b1729:s=640x360 -frames:v 1 "$FILM/assets/card.png"

cat > "$FILM/filmkit.yaml" <<'YAML'
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: qwentts-e2e, title: "qwentts e2e" }
profiles:
  - ref: filmkit/static
  - ref: ./profiles/qwentts.yaml
assets:
  voice:
    kind: audio
    impl:
      profile: qwentts
      task: speak
      params:
        text: "这件事，我们不急着下结论。先确认事实，再判断责任。"
        model: customvoice
        voice: Serena
        emotionIntensity: low
        instruct: "亲切、稳定、专业，语气克制但有起伏"
        speed: 0.98
    produces: { audio: ./build/voice/s1.wav }
output:
  container: mp4
  video: { width: 640, height: 360, fps: 25, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
  background: "0x0b1729"
scenes:
  - id: s1
    duration: 2          # deliberately shorter than the narration
    durationPolicy: min
    audio: voice
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }
YAML

cd "$FILM"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")
say "doctor (cheap healthcheck: --print-models)"
"${FK[@]}" doctor >/dev/null || fail "doctor reported a problem"
say "validate + plan"
"${FK[@]}" validate
"${FK[@]}" plan | grep -q 's1 \[blocked\]' || fail "the scene should wait for its narration"

say "run (real Qwen3-TTS generation)"
"${FK[@]}" run voice
[ -s build/voice/s1.wav ] || fail "no narration was produced"
voice_dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/voice/s1.wav)
echo "narration: ${voice_dur}s"

say "build"
"${FK[@]}" build
film_dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 build/qwentts-e2e.mp4)
echo "film: ${film_dur}s"
python3 - "$voice_dur" "$film_dur" <<'PY' || fail "the film did not follow the narration's length"
import sys
voice, film = float(sys.argv[1]), float(sys.argv[2])
assert voice > 2.5, f"narration suspiciously short: {voice}"
assert abs(film - voice) < 0.3, (film, voice)
PY
spec=$(ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 build/qwentts-e2e.mp4 | tr '\n' ' ')
echo "$spec" | grep -q '48000,2' || fail "audio spec wrong: $spec"

say "staleness follows the text"
printf 'x' >> /dev/null
"${FK[@]}" plan | grep -q 'nothing to do' || fail "expected an up-to-date plan after build"
python3 - <<'PY'
p = "filmkit.yaml"
s = open(p, encoding="utf-8").read().replace("先确认事实，再判断责任。", "先确认事实，再判断责任，再决定行动。")
open(p, "w", encoding="utf-8").write(s)
PY
"${FK[@]}" plan | grep -q 'voice \[stale\]' || fail "editing the text did not mark the narration stale"

printf '\n\033[1mOK\033[0m  (%s)\n' "$FILM"
