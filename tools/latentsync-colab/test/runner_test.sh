#!/usr/bin/env bash
# Offline test of vm/ls_runner.py status protocol + watchdog, with setup skipped and a fake venv python that
# stands in for ls_infer.py. No GPU, no network. Usage: test/runner_test.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }
mkroot() {  # $1 dir, $2 fake-infer mode
  mkdir -p "$1/root/vm" "$1/root/out" "$1/root/logs" "$1/venv/bin" "$1/ls"
  cp "$HERE"/vm/*.py "$HERE"/vm/pins.json "$1/root/vm/"
  printf '{"clips":[{"id":"a","video":"a.mp4","audio":"a.wav","frames":3},{"id":"b","video":"b.mp4","audio":"b.wav","frames":3}],"hardDeadlineEpoch":%s,"heartbeatStaleSec":%s}' "$3" "$4" > "$1/root/config.json"
  cat > "$1/venv/bin/python" <<SH
#!/usr/bin/env bash
R=\$3/out/results.jsonl
echo '{"event":"loaded","loadSec":12.5}' >> \$R
case "$2" in
  ok)   echo '{"id":"a","state":"done","wallSec":10,"peakVramMiB":15000,"output":"out/a.raw.mp4"}' >> \$R
        echo '{"id":"b","state":"done","wallSec":11,"peakVramMiB":15100,"output":"out/b.raw.mp4"}' >> \$R; exit 0;;
  fail) echo '{"id":"a","state":"done","wallSec":10}' >> \$R; echo '{"id":"b","state":"failed","error":"RuntimeError: Face not detected"}' >> \$R; exit 1;;
  hang) echo '{"id":"a","state":"running"}' >> \$R; sleep 600;;
esac
SH
  chmod +x "$1/venv/bin/python"; touch "$1/root/host.heartbeat"
}
wait_phase() {  # dir, timeout -> prints phase once terminal
  for _ in $(seq 1 "$2"); do ph=$(python3 -c "import json; print(json.load(open('$1/root/status.json'))['phase'])" 2>/dev/null); case "$ph" in done|failed|aborted) echo "$ph"; return;; esac; sleep 1; done; echo "timeout:$ph"; }
start() { LS_ROOT="$1/root" LS_DIR="$1/ls" LS_VENV="$1/venv" LS_SKIP_SETUP=1 python3 -u "$1/root/vm/ls_runner.py" > "$1/runner.log" 2>&1 & echo $!; }
far=$(( $(date +%s) + 3600 ))

mkroot "$T/1" ok $far 900; p=$(start "$T/1"); ph=$(wait_phase "$T/1" 30); kill $p
ok "all clips done -> phase done" '[ "$ph" = done ]'
ok "per-clip wallSec/peakVram + loadSec merged" 'python3 -c "import json,sys; d=json.load(open(\"$T/1/root/status.json\")); sys.exit(0 if d[\"loadSec\"]==12.5 and d[\"clips\"][1][\"peakVramMiB\"]==15100 and d[\"clips\"][0][\"wallSec\"]==10 else 1)"'

mkroot "$T/2" fail $far 900; p=$(start "$T/2"); ph=$(wait_phase "$T/2" 30); kill $p
ok "one failed clip -> phase failed, other clip kept done" '[ "$ph" = failed ] && python3 -c "import json,sys; d=json.load(open(\"$T/2/root/status.json\")); sys.exit(0 if d[\"clips\"][0][\"state\"]==\"done\" and \"Face not detected\" in d[\"clips\"][1][\"error\"] else 1)"'

mkroot "$T/3" hang $far 900; p=$(start "$T/3"); sleep 3; touch "$T/3/root/abort"; ph=$(wait_phase "$T/3" 30); kill $p
ok "abort file kills the hung step -> aborted, no release.request" '[ "$ph" = aborted ] && [ ! -e "$T/3/root/release.request" ] && ! pgrep -f "$T/3/venv" >/dev/null'

mkroot "$T/4" hang $(( $(date +%s) + 4 )) 900; p=$(start "$T/4"); ph=$(wait_phase "$T/4" 40); sleep 1; kill $p
ok "hard deadline -> aborted + release.request" '[ "$ph" = aborted ] && grep -q hard-deadline "$T/4/root/release.request"'

mkroot "$T/5" hang $far 3; touch -d "-10 seconds" "$T/5/root/host.heartbeat"; p=$(start "$T/5"); ph=$(wait_phase "$T/5" 40); sleep 1; kill $p
ok "stale host heartbeat -> aborted + release.request" '[ "$ph" = aborted ] && grep -q heartbeat-missing "$T/5/root/release.request"'

echo "# pass $pass fail $fail"; [ "$fail" = 0 ] && rm -rf "$T" || echo "kept $T"; [ "$fail" = 0 ]
