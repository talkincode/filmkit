#!/usr/bin/env bash
# Offline lifecycle tests for run.sh against test/fake_colab.sh (no Colab, no network). Usage: test/run_test.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap '[ "$fail" = 0 ] && rm -rf "$T" || echo "kept $T"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }
# small real inputs via prep_inputs.sh conventions: 2 clips, 25 fps
mkdir -p "$T/in"
for spec in a:30 b:41; do id=${spec%%:*}; n=${spec##*:}
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=size=768x1024:rate=25" -frames:v $n -pix_fmt yuv420p "$T/in/$id.mp4"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "sine=f=220:sample_rate=24000" -t $(python3 -c "print($n/25)") -ac 1 -c:a pcm_s16le "$T/in/$id.wav"
done
python3 - "$T/in" <<'PY'
import hashlib, json, sys
d = sys.argv[1]; h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
json.dump([{"id": i, "frames": n, "video": i + ".mp4", "audio": i + ".wav", "videoSha256": h(f"{d}/{i}.mp4"),
            "audioSha256": h(f"{d}/{i}.wav")} for i, n in (("a", 30), ("b", 41))], open(d + "/manifest.json", "w"))
PY
printf '#!/bin/sh\nexec bash "%s" "$@"\n' "$HERE/test/fake_colab.sh" > "$T/colab"; chmod +x "$T/colab"  # works without exec bits
export COLAB_BIN="$T/colab" LS_POLL_SEC=0 LS_BACKOFF="0 0 0" LS_USAGE_SLEEP=0
run() { FAKE_DIR="$T/f$1" bash "$HERE/run.sh" --gpu L4 --inputs "$T/in" --out "$T/o$1" "${@:2}" > "$T/log$1" 2>&1; echo $?; }

rc=$(run 1)
ok "happy path exits 0" '[ "$rc" = 0 ]'
ok "run.json: release verified + 0 assignments" 'python3 -c "import json,sys; r=json.load(open(\"$T/o1/run.json\")); sys.exit(0 if r[\"sessionReleasedVerified\"] and r[\"zeroAssignments\"] and r[\"actualCU\"]==0.5 and r[\"usageSettled\"] else 1)"'
ok "finalized clip trimmed to manifest frames" '[ "$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$T/o1/a.ls.mp4")" = 30 ]'
ok "finalized clip carries the drive audio" '[ "$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$T/o1/b.ls.mp4")" = 48000 ]'
ok "no --env and no --high-mem ever passed" '! grep -Eq -- "--env|--high-mem" "$T/f1/calls"'
ok "exactly one new, with --gpu L4" '[ "$(grep -c "^--auth adc new" "$T/f1/calls")" = 1 ] && grep -q "new -s ls-ep004-l4 --gpu L4" "$T/f1/calls"'

mkdir -p "$T/f2"; rc=$(FAKE_EXISTING=1 run 2)
ok "refuses when a session already exists (rc 2, no new)" '[ "$rc" = 2 ] && ! grep -q " new " "$T/f2/calls"'

rc=$(FAKE_STICKY_STOPS=2 run 3)
ok "sticky stop is retried and then verified" '[ "$rc" = 0 ] && [ "$(cat "$T/f3/stops")" = 3 ]'

rc=$(FAKE_STICKY_STOPS=99 run 4)
ok "unreleasable session -> exit 3 + loud warning" '[ "$rc" = 3 ] && grep -q "TEARDOWN NOT VERIFIED" "$T/log4"'

rc=$(FAKE_NO_CHARGE=1 run 8)
ok "charge not posted yet -> actualCU null, not 0" '[ "$rc" = 0 ] && python3 -c "import json,sys; r=json.load(open(\"$T/o8/run.json\")); sys.exit(0 if r[\"actualCU\"] is None and not r[\"usageSettled\"] else 1)"'

rc=$(FAKE_CLIP_FAIL=b run 5)
ok "failed clip -> exit 1, good clip still downloaded, session stopped" '[ "$rc" = 1 ] && [ -s "$T/o5/a.ls.mp4" ] && [ ! -e "$T/o5/b.raw.mp4" ] && [ ! -f "$T/f5/session" ]'

rc=$(FAKE_DIR="$T/f6" bash "$HERE/run.sh" --gpu A100 --inputs "$T/in" --out "$T/o6" --budget-cu 0.9 --dry-run 2>&1 | grep -o "deadline=[0-9]*min")
ok "--budget-cu caps the A100 deadline (0.9 CU / 5.3 CU/h = 10 min)" '[ "$rc" = "deadline=10min" ]'
ok "--budget-cu shortens the VM grace to 120 s" 'python3 -c "import json,sys,os; c=json.load(open(\"$T/o6/config.json\")); sys.exit(0 if 0 < c[\"hardDeadlineEpoch\"] - os.path.getmtime(\"$T/o6/config.json\") - 600 <= 125 else 1)"'
ok "dry run makes no colab call" '[ ! -e "$T/f6/calls" ]'
rc=$(FAKE_DIR="$T/f7" bash "$HERE/run.sh" --gpu H100 --inputs "$T/in" --out "$T/o7" >/dev/null 2>&1; echo $?)
ok "H100 refused" '[ "$rc" = 2 ] && [ ! -e "$T/f7/calls" ]'

for f in "$HERE"/vm/*.py "$HERE"/preflight_faces.py; do python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$f" || fail=$((fail+1)); done
for s in run.sh prep_inputs.sh compare.sh; do bash -n "$HERE/$s" || { echo "FAIL - bash -n $s"; fail=$((fail+1)); }; done
echo "# pass $pass fail $fail"; [ "$fail" = 0 ]
