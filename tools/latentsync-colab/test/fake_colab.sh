#!/usr/bin/env bash
# Fake `colab` CLI for test/run_test.sh. State in $FAKE_DIR. Knobs: FAKE_EXISTING=1 (a session already listed),
# FAKE_STICKY_STOPS=N (first N stops do nothing), FAKE_CLIP_FAIL=<id> (that clip ends failed).
set -u
D=${FAKE_DIR:?}; mkdir -p "$D"
echo "$*" >> "$D/calls"
while [ $# -gt 0 ]; do case "$1" in --auth|--config) shift 2;; *) break;; esac; done
cmd=$1; shift
sess=""; args=()
while [ $# -gt 0 ]; do case "$1" in -s) sess=$2; shift 2;; -f) file=$2; shift 2;; --timeout|--gpu) shift 2;; *) args+=("$1"); shift;; esac; done
bal=$(cat "$D/balance" 2>/dev/null || echo 100.00)
case "$cmd" in
  version) echo "colab-cli 0.7.4";;
  sessions)
    [ "${FAKE_EXISTING:-0}" = 1 ] && echo "[other] https://x | Hardware: A100 | Shape: standard | Variant: GPU"
    if [ -f "$D/session" ]; then echo "[$(cat "$D/session")] https://x | Hardware: L4 | Shape: standard | Variant: GPU"
    else echo "[colab] No active sessions found on server."; fi;;
  usage) n=0; [ -f "$D/session" ] && n=1; [ "${FAKE_EXISTING:-0}" = 1 ] && n=$((n+1))
    printf 'Current balance: %s\nUsage rate: 1.71 / hr\nActive assignments: %s\n' "$bal" "$n";;
  new) echo "$sess" > "$D/session"; echo "[colab] Session '$sess' created";;
  upload) cp "${args[0]}" "$D/bundle.tar.gz";;
  exec)
    case "$(basename "$file")" in
      ls_mkdirs.py) echo 'FKSTATUS {"ok":true,"root":"/content/ls"}';;
      ls_kick.py) mkdir -p "$D/x" && tar xzf "$D/bundle.tar.gz" -C "$D/x" && echo 'FKSTATUS {"ok":true,"kicked":true,"pid":42}';;
      ls_abort.py) touch "$D/aborted"; echo 'FKSTATUS {"ok":true,"abort":true}';;
      ls_poll.py) n=$(( $(cat "$D/polls" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/polls"
        python3 - "$D" "$n" "${FAKE_CLIP_FAIL:-}" <<'PY'
import json, sys
d, n, bad = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg = json.load(open(d + "/x/config.json"))
done = n >= 3
clips = [{"id": c["id"], "state": ("failed" if c["id"] == bad else "done") if done else "queued",
          "wallSec": 100.0 if done else None} for c in cfg["clips"]]
st = {"protocol": "latentsync-colab/v1", "ok": True, "phase": ("failed" if bad else "done") if done else ("setup" if n < 2 else "infer"),
      "clips": clips, "setup": {"setupSec": 300} if n >= 2 else {}, "runnerAlive": True}
json.dump(st, open(d + "/status.json", "w"))
print("noise line"); print("FKSTATUS " + json.dumps(st))
PY
        ;;
    esac;;
  download) remote=${args[0]}; local=${args[1]}; mkdir -p "$(dirname "$local")"
    case "$remote" in
      */status.json) cp "$D/status.json" "$local";;
      *.raw.mp4) id=$(basename "$remote" .raw.mp4)
        n=$(python3 -c "import json; print([c['frames'] for c in json.load(open('$D/x/config.json'))['clips'] if c['id']=='$id'][0])")
        ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=size=768x1024:rate=25" -f lavfi -i "sine=f=440:sample_rate=16000" \
          -frames:v $((n+2)) -t $(python3 -c "print(($n+2)/25)") -c:v libx264 -pix_fmt yuv420p -c:a aac "$local";;
      *) echo "fake $remote" > "$local";;
    esac;;
  stop) s=$(cat "$D/stops" 2>/dev/null || echo 0); echo $((s+1)) > "$D/stops"
    if [ "$s" -ge "${FAKE_STICKY_STOPS:-0}" ] && [ -f "$D/session" ]; then rm -f "$D/session"; python3 -c "print('%.2f' % ($bal - 0.5))" > "$D/balance"; fi
    echo "[colab] stopped";;
  restart-kernel) echo "restarted";;
  *) echo "fake colab: unknown $cmd" >&2; exit 1;;
esac
exit 0
