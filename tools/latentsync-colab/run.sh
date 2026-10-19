#!/usr/bin/env bash
# latentsync-colab/v1 -- host driver: one Colab session, LatentSync 1.6 lip sync over every prepared clip,
# download, stop, verify. Conventions copied from tools/colab-comfy (src/colab.ts, src/teardown.ts):
#   * every `colab` call runs under a host `timeout` (the CLI's own --timeout is unreliable, M0 F2);
#   * `colab exec` rc is always 0: success is ONLY the last `FKSTATUS {json}` line (A1); an exec that hit the host
#     timeout is followed by `restart-kernel` (a killed exec client wedges the next exec, A2);
#   * no secrets anywhere, and never `--env` (A3): the VM needs none (all weights are public);
#   * `colab stop` rc is 0 even for a missing session (A7): release is verified by `colab sessions` not listing it
#     and `colab usage` showing 0 active assignments; stop+verify is retried 3x with backoff (cleanup, not spend);
#   * one session at a time: refuses to start when any session or assignment exists; never H100, never --high-mem.
# Usage:
#   run.sh --gpu L4|A100 [--inputs DIR] [--out DIR] [--session NAME] [--deadline-min N] [--budget-cu X] [--dry-run]
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COLAB_BIN=${COLAB_BIN:-colab}
COLAB_AUTH=${COLAB_AUTH:-${COLAB_COMFY_AUTH:-adc}}
POLL_SEC=${LS_POLL_SEC:-20}
BACKOFF=(${LS_BACKOFF:-10 30 60})
USAGE_SLEEP=${LS_USAGE_SLEEP:-20}
GPU="" INPUTS=/workspace/tmp/latentsync/inputs OUT="" SESSION="" DEADLINE_MIN="" BUDGET_CU="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) GPU=$2; shift 2;; --inputs) INPUTS=$2; shift 2;; --out) OUT=$2; shift 2;;
    --session) SESSION=$2; shift 2;; --deadline-min) DEADLINE_MIN=$2; shift 2;; --budget-cu) BUDGET_CU=$2; shift 2;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n 2,14p "$0"; exit 0;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
case "$GPU" in
  L4) RATE_NOMINAL=1.71; DEF_DEADLINE=50;;     # measured L4 1.46-1.71 CU/h: budget with the high end
  A100) RATE_NOMINAL=5.3; DEF_DEADLINE=35;;    # measured A100 5.3 CU/h nominal (~4.2 effective billed)
  H100|h100) echo "refused: never H100" >&2; exit 2;;
  *) echo "--gpu L4|A100 is required" >&2; exit 2;;
esac
DEADLINE_MIN=${DEADLINE_MIN:-$DEF_DEADLINE}
if [ -n "$BUDGET_CU" ]; then  # the session may not run longer than the budget allows at the nominal rate
  cap=$(python3 -c "print(int($BUDGET_CU/$RATE_NOMINAL*60))")
  [ "$cap" -lt "$DEADLINE_MIN" ] && DEADLINE_MIN=$cap
fi
TS=$(date +%Y%m%d-%H%M%S)
OUT=${OUT:-/workspace/tmp/latentsync/runs/$TS-$GPU}
SESSION=${SESSION:-ls-ep004-$(echo "$GPU" | tr 'A-Z' 'a-z')}
mkdir -p "$OUT/logs" "$OUT/vm"
CALLS="$OUT/logs/colab-calls.log"

log() { echo "$(date +%H:%M:%S) $*" | tee -a "$OUT/logs/host.log" >&2; }
redact() { sed -E 's/(hf_|ya29\.|ghp_|gho_)[A-Za-z0-9._-]{10,}/\1[REDACTED]/g; s/((token|secret|password|key)[^=:]*[=:] *)[^ ,"]+/\1[REDACTED]/Ig'; }
# c <timeout-sec> <colab args...>: one colab call under a host timeout; stdout -> $C_OUT, rc -> $C_RC.
c() {
  local t=$1; shift
  local tmp; tmp=$(mktemp)
  timeout -k 5 "$t" "$COLAB_BIN" --auth "$COLAB_AUTH" ${COLAB_CLI_CONFIG:+--config "$COLAB_CLI_CONFIG"} "$@" > "$tmp" 2>&1 </dev/null
  C_RC=$?
  C_OUT=$(redact < "$tmp"); rm -f "$tmp"
  printf '\n### %s colab %s (rc=%s)\n%s\n' "$(date +%T)" "$*" "$C_RC" "$C_OUT" >> "$CALLS"
  return 0
}
fkstatus() { python3 -c '
import json,sys
for l in reversed(sys.stdin.read().splitlines()):
    l=l.rstrip("\r")
    if l.startswith("FKSTATUS "):
        try:
            v=json.loads(l[9:])
            if isinstance(v,dict): print(json.dumps(v)); break
        except ValueError: pass'; }
jget() { python3 -c "import json,sys; d=json.loads(sys.stdin.read() or 'null'); print(eval(sys.argv[1], {'d': d}))" "$1" 2>/dev/null; }
# vexec <script> <timeout>: FKSTATUS json in $FK (empty = failure); restart-kernel after a host timeout.
vexec() {
  c "$2" exec -s "$SESSION" -f "$HERE/vm/$1" --timeout $(( $2 + 30 ))
  FK=$(printf '%s' "$C_OUT" | fkstatus)
  if [ "$C_RC" = 124 ] || [ "$C_RC" = 137 ]; then log "exec $1 hit the host timeout: restart-kernel"; c 60 restart-kernel -s "$SESSION"; FK=""; fi
}
session_listed() {  # 0 = listed, 1 = not listed, 2 = unknown
  c 60 sessions; [ "$C_RC" = 0 ] || return 2
  printf '%s\n' "$C_OUT" | grep -Eq "^\[$SESSION\][[:space:]]+[^[:space:]]+[[:space:]]*\|[[:space:]]*Hardware:" && return 0 || return 1
}
usage_field() { printf '%s' "$1" | python3 -c "
import re,sys; s=sys.stdin.read(); m=re.search(sys.argv[1], s, re.I); print(m.group(1) if m else '')" "$2"; }
read_usage() { c 60 usage; [ "$C_RC" = 0 ] || { BAL=""; ASSIGN=""; return 1; }
  BAL=$(usage_field "$C_OUT" 'Current balance:\s*(-?\d+(?:\.\d+)?)'); ASSIGN=$(usage_field "$C_OUT" 'Active assignments:\s*(\d+)'); }

# ---------------------------------------------------------------- bundle (local, no Colab)
[ -f "$INPUTS/manifest.json" ] || { echo "no $INPUTS/manifest.json: run prep_inputs.sh first" >&2; exit 2; }
DEADLINE_EPOCH=$(( $(date +%s) + DEADLINE_MIN * 60 ))
# VM self-release grace after the host deadline: 300 s, or 120 s under --budget-cu so a vanished host costs at most
# (deadline + 2 min) x nominal rate (A100, 1.0 CU: 11 + 2 = 13 min = 1.15 CU nominal, ~0.91 at the 4.2 effective rate).
VM_GRACE=300; [ -n "$BUDGET_CU" ] && VM_GRACE=120
HERE_DIR="$HERE" VM_GRACE="$VM_GRACE" python3 - "$INPUTS" "$OUT" "$DEADLINE_EPOCH" "$GPU" <<'PY' || exit 2
import hashlib, json, os, shutil, sys, tarfile
inputs, out, deadline, gpu = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
man = json.load(open(os.path.join(inputs, "manifest.json")))
clips = []
for m in man:
    for k in ("video", "audio"):
        p = os.path.join(inputs, m[k]); h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if h != m[k + "Sha256"]: sys.exit("input changed since prep: %s" % p)
    clips.append({"id": m["id"], "video": m["video"], "audio": m["audio"], "frames": m["frames"]})
# VM watchdog: hard deadline VM_GRACE s after the host deadline (the host stops first), host heartbeat stale 15 min.
cfg = {"protocol": "latentsync-colab/v1", "gpuRequested": gpu, "clips": clips,
       "hardDeadlineEpoch": deadline + int(os.environ["VM_GRACE"]), "heartbeatStaleSec": 900}
json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1)
with tarfile.open(os.path.join(out, "bundle.tar.gz"), "w:gz") as tf:
    tf.add(os.path.join(out, "config.json"), "config.json")
    vm = os.path.join(os.environ["HERE_DIR"], "vm")
    for f in sorted(os.listdir(vm)):
        if f.endswith((".py", ".json", ".txt")): tf.add(os.path.join(vm, f), "vm/" + f)
    for cl in clips:
        for k in ("video", "audio"): tf.add(os.path.join(inputs, cl[k]), "inputs/" + cl[k])
print("bundle: %d clips, %d bytes" % (len(clips), os.path.getsize(os.path.join(out, "bundle.tar.gz"))))
PY
cp "$INPUTS/manifest.json" "$OUT/manifest.json"
log "gpu=$GPU session=$SESSION deadline=${DEADLINE_MIN}min (host stops by $(date -d @$DEADLINE_EPOCH +%H:%M) Asia/Shanghai) out=$OUT"
if [ "$DRY" = 1 ]; then log "dry run: bundle built, no Colab call made"; exit 0; fi

# ---------------------------------------------------------------- preflight: one session at a time
c 30 version; [ "$C_RC" = 0 ] || { log "colab CLI not usable (rc $C_RC)"; exit 2; }
c 60 sessions; if [ "$C_RC" != 0 ]; then log "cannot list sessions"; exit 2; fi
if printf '%s\n' "$C_OUT" | grep -Eq '^\[[^]]+\][[:space:]]+[^[:space:]]+[[:space:]]*\|[[:space:]]*Hardware:'; then log "refused: a Colab session already exists:"; printf '%s\n' "$C_OUT" >&2; exit 2; fi
read_usage || { log "cannot read colab usage"; exit 2; }
[ "$ASSIGN" = 0 ] || { log "refused: colab usage shows $ASSIGN active assignment(s)"; exit 2; }
BAL_BEFORE=$BAL; log "usage before: balance $BAL_BEFORE CU, 0 assignments"

# ---------------------------------------------------------------- session
T0=$(date +%s); STOPPED=0; RESULT=1
teardown() {
  [ "$STOPPED" = 1 ] && return; STOPPED=1
  local verified=0 i
  for i in 0 1 2; do
    c 120 stop -s "$SESSION"
    session_listed; [ $? = 1 ] && { verified=1; break; }
    log "stop attempt $((i+1)): $SESSION still listed or unknown; retry in ${BACKOFF[$i]}s"; sleep "${BACKOFF[$i]}"
  done
  [ "$verified" = 1 ] || { session_listed; [ $? = 1 ] && verified=1; }
  local assign_ok=0 prev="" settled=0
  for i in 1 2 3 4 5 6; do  # usage settles a little after release: two equal balance readings = settled
    read_usage; [ "$ASSIGN" = 0 ] && assign_ok=1
    [ "$assign_ok" = 1 ] && [ -n "$BAL" ] && [ "$BAL" = "$prev" ] && { settled=1; break; }
    prev=$BAL; sleep "$USAGE_SLEEP"
  done
  T1=$(date +%s)
  python3 - "$OUT" "$GPU" "$SESSION" "$T0" "$T1" "$BAL_BEFORE" "$BAL" "$settled" "$verified" "$assign_ok" <<'PY'
import json, os, sys
out, gpu, sess, t0, t1, b0, b1, settled, ver, asg = sys.argv[1:]
st = {}
try: st = json.load(open(os.path.join(out, "status.json")))
except Exception: pass
cu = round(float(b0) - float(b1), 3) if b0 and b1 else None
rec = {"protocol": "latentsync-colab/v1", "gpu": gpu, "session": sess, "wallSec": int(t1) - int(t0),
       "usageBeforeCU": b0, "usageAfterCU": b1, "actualCU": cu, "usageSettled": settled == "1",
       "sessionReleasedVerified": ver == "1", "zeroAssignments": asg == "1",
       "effectiveCUPerHour": round(cu / ((int(t1) - int(t0)) / 3600), 2) if cu else None,
       "vm": {k: st.get(k) for k in ("phase", "error", "setup", "env", "loadSec", "clips", "watchdog")}}
json.dump(rec, open(os.path.join(out, "run.json"), "w"), indent=1)
print(json.dumps({k: rec[k] for k in ("wallSec", "actualCU", "usageSettled", "sessionReleasedVerified", "zeroAssignments")}))
PY
  if [ "$verified" = 1 ] && [ "$assign_ok" = 1 ]; then log "teardown verified: no session, 0 assignments"
  else log "!!! TEARDOWN NOT VERIFIED: run '$COLAB_BIN sessions' and '$COLAB_BIN usage' now and stop $SESSION by hand"; RESULT=3; fi
}
trap 'log "signal: stopping"; teardown; exit 130' INT TERM
trap 'teardown; [ "$RESULT" = 3 ] && exit 3' EXIT

log "colab new --gpu $GPU"
c 420 new -s "$SESSION" --gpu "$GPU"
[ "$C_RC" = 0 ] || { log "colab new failed (rc $C_RC): stopping"; exit 1; }
vexec ls_mkdirs.py 120; [ "$(printf '%s' "$FK" | jget 'd["ok"]')" = True ] || { log "mkdirs failed: $FK"; exit 1; }
c 600 upload -s "$SESSION" "$OUT/bundle.tar.gz" /content/ls/bundle.tar.gz
[ "$C_RC" = 0 ] || { log "upload failed (rc $C_RC)"; exit 1; }
vexec ls_kick.py 120; [ "$(printf '%s' "$FK" | jget 'd["ok"]')" = True ] || { log "kick failed: $FK"; exit 1; }
log "runner started: $FK"

fails=0; last=""; ABORTED=0
while :; do
  sleep "$POLL_SEC"
  if [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ] && [ "$ABORTED" = 0 ]; then
    log "host deadline reached: abort"; vexec ls_abort.py 60; ABORTED=1; continue
  fi
  vexec ls_poll.py 60
  if [ -z "$FK" ]; then fails=$((fails+1)); log "poll failed ($fails/3)"; [ $fails -ge 3 ] && { log "session lost"; break; }; continue; fi
  fails=0
  printf '%s' "$FK" > "$OUT/status.json"
  line=$(printf '%s' "$FK" | jget '"phase=%s %s %s" % (d.get("phase"), " ".join("%s:%s%s" % (c["id"], c["state"], ("(%ss)" % c["wallSec"]) if c.get("wallSec") else "") for c in d.get("clips", [])), ("setup=%s" % d["setup"]) if d.get("setup") else "")')
  [ "$line" != "$last" ] && log "$line"; last=$line
  ph=$(printf '%s' "$FK" | jget 'd.get("phase")'); rel=$(printf '%s' "$FK" | jget 'd.get("releasing")')
  [ "$rel" = True ] && { log "VM watchdog released the session"; break; }
  case "$ph" in done|failed|aborted) break;; esac
  if [ "$(printf '%s' "$FK" | jget 'd.get("runnerAlive")')" = False ]; then log "runner died"; break; fi
done

# ---------------------------------------------------------------- collect (bounded), then stop
for f in status.json logs/runner.log logs/setup.log logs/infer.log out/results.jsonl; do
  c 300 download -s "$SESSION" "/content/ls/$f" "$OUT/vm/$(basename "$f")"
done
[ -f "$OUT/vm/status.json" ] && cp "$OUT/vm/status.json" "$OUT/status.json"
ok_all=1
for id in $(python3 -c "import json; [print(c['id']) for c in json.load(open('$OUT/config.json'))['clips']]"); do
  state=$(jget 'next((c["state"] for c in d.get("clips",[]) if c["id"]=="'"$id"'"), "?")' < "$OUT/status.json" 2>/dev/null)
  if [ "$state" = done ]; then
    c 600 download -s "$SESSION" "/content/ls/out/$id.raw.mp4" "$OUT/$id.raw.mp4"
    [ "$C_RC" = 0 ] && [ -s "$OUT/$id.raw.mp4" ] || { log "download $id failed"; ok_all=0; }
  else log "$id: $state"; ok_all=0; fi
done
teardown

# ---------------------------------------------------------------- local finalize (box only)
# LatentSync muxes 16 kHz AAC; keep its video, trim the 1-3 ping-pong frames it appends when the whisper chunk
# count exceeds the frame count, and mux the original 24 kHz drive audio back on.
for id in $(python3 -c "import json; [print(c['id']) for c in json.load(open('$OUT/config.json'))['clips']]"); do
  [ -s "$OUT/$id.raw.mp4" ] || continue
  n=$(python3 -c "import json; print([c['frames'] for c in json.load(open('$OUT/config.json'))['clips'] if c['id']=='$id'][0])")
  ffmpeg -nostdin -y -loglevel error -i "$OUT/$id.raw.mp4" -i "$INPUTS/$id.wav" -map 0:v:0 -map 1:a:0 -frames:v "$n" \
    -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -shortest "$OUT/$id.ls.mp4" \
    && log "$id -> $OUT/$id.ls.mp4 ($(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/$id.ls.mp4") frames)"
done
[ "$RESULT" = 3 ] && exit 3
[ "$ok_all" = 1 ] && exit 0 || exit 1
