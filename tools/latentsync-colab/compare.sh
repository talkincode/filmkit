#!/usr/bin/env bash
# Side-by-side OLD vs NEW with sound, after a run.sh run (box only, no Colab).
#   left : old H3 clip (its own H3 audio dropped), 24 -> 25 fps by frame duplication, trimmed to the same N frames
#   right: LatentSync output <run>/<id>.ls.mp4 (25 fps, N frames, drive audio already muxed by run.sh)
#   audio: the NEW audio = prepared drive wav <inputs>/<id>.wav, for both halves
# Output: <out>/<id>.sbs.mp4 (1536x1024, labels burned in) and <out>/sbs_all.mp4 (all clips in manifest order).
# Usage: compare.sh --run DIR [--inputs DIR] [--old-dir DIR] [--out DIR]
set -euo pipefail
RUN="" INPUTS=/workspace/tmp/latentsync/inputs OLD=/workspace/weila-ep04/h3/build_h3_before_fl2va OUT=""
while [ $# -gt 0 ]; do case "$1" in
  --run) RUN=$2; shift 2;; --inputs) INPUTS=$2; shift 2;; --old-dir) OLD=$2; shift 2;; --out) OUT=$2; shift 2;;
  *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[ -n "$RUN" ] || { echo "--run DIR is required" >&2; exit 2; }
OUT=${OUT:-$RUN/compare}; mkdir -p "$OUT"
FONT=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}
old_label() { case "$1" in s09b) echo "OLD  H3 v1 (no audio drive)";; s01c) echo "OLD  H3 v3 (audio-guided)";; *) echo "OLD  H3";; esac; }
list="$OUT/concat.txt"; : > "$list"
for row in $(python3 -c "import json; [print('%s:%d' % (c['id'], c['frames'])) for c in json.load(open('$INPUTS/manifest.json'))]"); do
  id=${row%%:*}; n=${row##*:}
  new="$RUN/$id.ls.mp4"; [ -s "$new" ] || { echo "skip $id: no $new" >&2; continue; }
  dt="fontfile=$FONT:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12"
  ffmpeg -nostdin -y -loglevel error -i "$OLD/$id.mp4" -i "$new" -i "$INPUTS/$id.wav" -filter_complex "
    [0:v]fps=25,scale=768:1024:flags=lanczos,setsar=1,
         drawtext=$dt:fontsize=30:x=20:y=20:text='$(old_label "$id")'[l];
    [1:v]scale=768:1024:flags=lanczos,setsar=1,
         drawtext=$dt:fontsize=30:x=20:y=20:text='NEW  LatentSync 1.6 (post lip sync)'[r];
    [l][r]hstack=inputs=2:shortest=1,drawtext=$dt:fontsize=26:x=(w-tw)/2:y=h-th-24:text='$id   audio\: new drive VO (both sides)   25 fps'[v]" \
    -map "[v]" -map 2:a:0 -frames:v "$n" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -ar 48000 "$OUT/$id.sbs.mp4"
  echo "$id -> $OUT/$id.sbs.mp4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$id.sbs.mp4")s)"
  echo "file '$OUT/$id.sbs.mp4'" >> "$list"
done
[ -s "$list" ] && ffmpeg -nostdin -y -loglevel error -f concat -safe 0 -i "$list" -c copy "$OUT/sbs_all.mp4" && echo "all -> $OUT/sbs_all.mp4"
