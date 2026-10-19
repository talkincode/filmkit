#!/usr/bin/env bash
# Prepare LatentSync input pairs on the box (no Colab). Idempotent.
#   video: old H3 clip, 24 fps -> 25 fps by frame duplication (same duration, no retime), trimmed to
#          N = round(dur*25) frames, video only, x264 crf 12 yuv420p.
#   audio: per-clip drive wav (24 kHz mono s16, already exactly frames/24 s long) trimmed or zero-padded to
#          exactly N/25 s = N*960 samples. Not resampled: LatentSync resamples to 16 kHz internally.
set -euo pipefail
SRC_V=${SRC_V:-/workspace/weila-ep04/h3/build_h3_before_fl2va}
SRC_A=${SRC_A:-/workspace/weila-ep04/h3/v4_fl2va/drive}
OUT=${OUT:-/workspace/tmp/latentsync/inputs}
CLIPS=${CLIPS:-"s09b s01c"}
mkdir -p "$OUT"
probe() { ffprobe -v error -select_streams "$2" -show_entries stream=duration,nb_frames,r_frame_rate,sample_rate -of default=nw=1 "$1" | tr '\n' ' '; }
manifest="$OUT/manifest.json"; echo "[" > "$manifest"; first=1
for id in $CLIPS; do
  v="$SRC_V/$id.mp4"; a="$SRC_A/${id}_drive.wav"
  vdur=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$v")
  adur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$a")
  n=$(python3 -c "print(round($vdur*25))")
  samples=$((n*960))
  ffmpeg -nostdin -y -loglevel error -i "$v" -an -vf "fps=25" -frames:v "$n" -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p "$OUT/$id.mp4"
  ffmpeg -nostdin -y -loglevel error -i "$a" -af "apad=whole_len=$samples,atrim=end_sample=$samples" -ar 24000 -ac 1 -c:a pcm_s16le "$OUT/$id.wav"
  got_n=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/$id.mp4")
  got_s=$(python3 -c "import wave; w=wave.open('$OUT/$id.wav'); print(w.getnframes())")
  [ "$got_n" = "$n" ] || { echo "frame count mismatch $id: $got_n != $n" >&2; exit 1; }
  [ "$got_s" = "$samples" ] || { echo "sample count mismatch $id: $got_s != $samples" >&2; exit 1; }
  echo "$id: src video ${vdur}s ($(probe "$v" v:0)) | drive ${adur}s -> in.mp4 $n f @25 = $(python3 -c "print($n/25)")s | in.wav $samples smp @24k = $(python3 -c "print($samples/24000)")s | delta video $(python3 -c "print(round($n/25-$vdur,4))")s audio $(python3 -c "print(round($samples/24000-$adur,4))")s"
  [ $first = 1 ] || echo "," >> "$manifest"; first=0
  printf '{"id":"%s","frames":%d,"fps":25,"durationSec":%s,"srcVideo":"%s","srcVideoSec":%s,"srcAudio":"%s","srcAudioSec":%s,"video":"%s.mp4","videoSha256":"%s","audio":"%s.wav","audioSha256":"%s"}' \
    "$id" "$n" "$(python3 -c "print($n/25)")" "$v" "$vdur" "$a" "$adur" "$id" "$(sha256sum "$OUT/$id.mp4"|cut -c1-64)" "$id" "$(sha256sum "$OUT/$id.wav"|cut -c1-64)" >> "$manifest"
done
echo "]" >> "$manifest"
