#!/usr/bin/env bash
# Real end-to-end run of the colab-comfy Profile on a Google Colab GPU (PLAN §8.3).
#
# NOT part of `bun test` and NOT free: one L4 session, ~0.8 CU (~0.77 estimated for the EP03 film).
# Needs: the `colab` CLI authenticated with ADC (`colab --auth adc sessions` works), bun, ffmpeg/ffprobe,
# and the three EP03 reference stills. The script REFUSES to spend unless you pass --yes; without it, it runs
# the free preflight (doctor / validate / plan / `batch --estimate`), prints the estimate and exits 5.
#
#   bash scripts/e2e-colab-comfy.sh <workdir> --refs <dir with ff_yM.png ff_bM.png ff_bC.png> [--yes] [--budget CU]
#   bash scripts/e2e-colab-comfy.sh --help
#
# Steps: sessions must be empty -> doctor/validate/plan -> estimate (printed first) -> [--yes] batch (one session,
# always stopped + verified by the helper) -> independent `colab sessions` check -> status + build --draft ->
# second estimate must say "nothing to generate" (0 CU) -> ffprobe each clip -> final report.
# The optional SIGINT drill (PLAN §8.3, ~0.1 CU) is deliberately NOT automated: run it by hand when approved.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH="${COLAB_COMFY_AUTH:-adc}"
WORK=""
REFS=""
YES=false
BUDGET="1.0"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --yes) YES=true ;;
    --budget) shift; [ $# -gt 0 ] || fail "--budget needs a value"; BUDGET="$1" ;;
    --refs) shift; [ $# -gt 0 ] || fail "--refs needs a directory"; REFS="$1" ;;
    -*) usage >&2; fail "unknown flag $1" ;;
    *) [ -z "$WORK" ] || fail "only one workdir"; WORK="$1" ;;
  esac
  shift
done

if [ -z "$WORK" ]; then
  usage >&2
  printf '\nrefusing: no workdir given, nothing was done (this script spends CU only with --yes).\n' >&2
  exit 2
fi

command -v bun >/dev/null || fail "bun not found"
command -v ffprobe >/dev/null || fail "ffprobe not found"
command -v colab >/dev/null || fail "colab CLI not found (see tools/colab-comfy/README.md)"
COLAB=(colab --auth "$AUTH")

mkdir -p "$WORK/profiles" "$WORK/refs" "$WORK/.bin"
WORK="$(cd "$WORK" && pwd)"
cp "$REPO_ROOT/profiles/colab-comfy.yaml" "$WORK/profiles/"
cp "$REPO_ROOT/tools/colab-comfy/examples/ep03-test/filmkit.yaml" "$WORK/filmkit.yaml"
if [ -n "$REFS" ]; then
  for f in ff_yM.png ff_bM.png ff_bC.png; do cp "$REFS/$f" "$WORK/refs/$f" || fail "missing $REFS/$f"; done
fi
for f in ff_yM.png ff_bM.png ff_bC.png; do [ -f "$WORK/refs/$f" ] || fail "missing $WORK/refs/$f (use --refs DIR)"; done

# Wrappers instead of touching ~/.local/bin: this run's PATH only.
printf '#!/bin/sh\nexec bun "%s/bin/filmkit.ts" "$@"\n' "$REPO_ROOT" > "$WORK/.bin/filmkit"
printf '#!/bin/sh\nexec bun "%s/tools/colab-comfy/bin/colab-comfy.ts" "$@"\n' "$REPO_ROOT" > "$WORK/.bin/colab-comfy"
chmod +x "$WORK/.bin/filmkit" "$WORK/.bin/colab-comfy"
export PATH="$WORK/.bin:$PATH"
cd "$WORK"

say "preflight (free): no active session, CU balance"
SESSIONS_BEFORE="$("${COLAB[@]}" sessions 2>&1)" || fail "colab sessions failed (auth?): $SESSIONS_BEFORE"
echo "$SESSIONS_BEFORE"
echo "$SESSIONS_BEFORE" | grep -q "No active sessions" || fail "active session(s) exist; stop them or run: colab-comfy reap (never touch sessions that are not yours)"
USAGE_BEFORE="$("${COLAB[@]}" usage 2>&1)" || fail "colab usage failed"
echo "$USAGE_BEFORE"

say "doctor / validate / plan"
filmkit doctor
filmkit validate
filmkit plan

say "CU estimate (printed BEFORE any session is opened)"
set +e
colab-comfy batch --film filmkit.yaml --estimate --budget "$BUDGET"
colab-comfy batch --film filmkit.yaml --estimate --budget "$BUDGET" --json > estimate.json
set -e
if [ "$YES" != true ]; then
  printf '\nrefusing to spend: estimate above. Re-run with --yes (and --budget CU if the estimate exceeds %s) after approval.\n' "$BUDGET" >&2
  exit 5
fi

say "batch: one session for the whole film (budget $BUDGET CU)"
set +e
colab-comfy batch --film filmkit.yaml --yes --budget "$BUDGET" --json > run1.json
BATCH_RC=$?
set -e
echo "batch exit code: $BATCH_RC"

say "independent check: no active session"
SESSIONS_AFTER="$("${COLAB[@]}" sessions 2>&1)" || true
echo "$SESSIONS_AFTER"
STOP_CONFIRMED=true
if ! echo "$SESSIONS_AFTER" | grep -q "No active sessions"; then
  STOP_CONFIRMED=false
  printf 'SESSION STILL ACTIVE - stopping our leftovers now\n' >&2
  colab-comfy reap --film filmkit.yaml || true
fi
"${COLAB[@]}" usage || true

report() {
  say "report"
  bun -e '
    const fs = require("fs");
    const tz = (iso) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) + " Asia/Shanghai";
    let r; try { r = JSON.parse(fs.readFileSync("run1.json", "utf8")); } catch { console.log("no batch report (run1.json unreadable)"); process.exit(0); }
    const s = r.session;
    let gpu = "unknown";
    for (const id of ["s1a", "s3a", "s4a"]) {
      try { gpu = JSON.parse(fs.readFileSync(`build/h3/${id}.colab.json`, "utf8")).runtime.gpu.name; break; } catch {}
    }
    const est = r.estimate && r.estimate.cu;
    console.log("session:        " + (s ? s.session : "none"));
    console.log("start:          " + (s ? tz(s.startedAt) : "-"));
    console.log("end:            " + (s ? tz(s.endedAt) : "-"));
    console.log("GPU:            " + gpu + " (requested " + r.gpu + ")");
    console.log("CU estimate:    " + est);
    console.log("CU used:        " + (s ? s.actualCU : "n/a") + (s && s.actualCU != null && est ? "  (actual/estimate = " + (s.actualCU / est).toFixed(2) + ")" : ""));
    console.log("jobs ok:        " + (s ? s.jobsOk + "/" + s.jobsTotal : "-") + ", outcome: " + (s ? s.outcome : "-"));
    console.log("stop confirmed: " + (s ? s.stop.verified : false) + " (helper); independent sessions check: " + process.argv[1]);
  ' "$STOP_CONFIRMED"
}

if [ "$BATCH_RC" -ne 0 ]; then
  report
  fail "batch exited $BATCH_RC (see run1.json); the session was stopped/verified by the helper, see above"
fi

say "status + draft build"
filmkit status
filmkit build --draft

say "second estimate: must be nothing to generate (0 CU, no session)"
colab-comfy batch --film filmkit.yaml --estimate --json > estimate2.json
bun -e 'const r = JSON.parse(require("fs").readFileSync("estimate2.json","utf8")); if (r.jobsToGenerate !== 0) { console.error("expected 0 jobs to generate, got " + r.jobsToGenerate); process.exit(1); } console.log("nothing to generate, 0 CU")' || fail "second batch would spend again"

say "ffprobe each clip: video + audio, 704x1280, 24 fps"
for id in s1a s3a s4a; do
  clip="build/h3/$id.mp4"
  [ -f "$clip" ] || fail "$clip missing"
  v="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$clip")"
  a="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$clip")"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clip")"
  echo "$id: video=$v audio=$a duration=$dur"
  [ -n "$a" ] || fail "$id has no audio stream"
  case "$v" in 704,1280,24/1) ;; *) fail "$id unexpected video stream: $v" ;; esac
done

report
[ "$STOP_CONFIRMED" = true ] || fail "session was still active in the independent check"
say "ok"
