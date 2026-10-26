#!/usr/bin/env bash
# Real end-to-end check of vflow-pull against the actual vflow code.
#
# Not part of `bun test`: it needs a vflow checkout (with node_modules) and node.
# It starts vflow's own local acceptance server (scripts/ui-test-server.ts:
# the real REST routes and domain, in-memory storage, synthetic media; loopback
# only, no production data and no credentials), pulls from it, and finishes the
# film with the real filmkit commands.
#
#   VFLOW_DIR=~/github/vflow bash scripts/e2e-vflow.sh [workdir]
#
# Asserts: the vflow export is read (v1 project and a v2 reference-authoring
# project), the reference images land sha256-identical to what vflow serves, the
# generated film is a legal filmkit project whose pending work is "place files",
# a film with clips placed builds to a video, and a pull that fails leaves the
# previous project untouched. vflow is only ever read.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VFLOW_DIR="${VFLOW_DIR:-$HOME/github/vflow}"
WORK="${1:-$(mktemp -d)}"
PORT=4179 # fixed by vflow's ui-test-server
BASE="http://127.0.0.1:$PORT"
FK=(bun "$REPO_ROOT/bin/filmkit.ts")
PULL=(bun "$REPO_ROOT/tools/vflow/bin/vflow-pull.ts")
SERVER_PID=""

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

[ -f "$VFLOW_DIR/scripts/ui-test-server.ts" ] || fail "no vflow checkout at $VFLOW_DIR (set VFLOW_DIR)"
[ -d "$VFLOW_DIR/node_modules" ] || fail "run npm ci in $VFLOW_DIR first"
command -v node >/dev/null || fail "node is required to run vflow's server"
command -v ffmpeg >/dev/null || fail "ffmpeg is required"
if curl -s -o /dev/null "$BASE/__test/reset" 2>/dev/null; then fail "something already listens on :$PORT; stop it (this script resets the server's data)"; fi

say "start vflow's acceptance server (loopback, in-memory)"
(cd "$VFLOW_DIR" && node scripts/ui-test-server.ts >"$WORK.server.log" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "$BASE/v1/projects" && break; sleep 0.25; done
curl -s -o /dev/null "$BASE/v1/projects" || { cat "$WORK.server.log" >&2; fail "vflow server did not start"; }
curl -s -XPOST "$BASE/__test/reset" >/dev/null
curl -s -XPOST "$BASE/__test/reference-fixture" >/dev/null

mkdir -p "$WORK/v1" "$WORK/v2"

say "pull a v1 composition (project demo, 100 shots)"
"${PULL[@]}" pull --base "$BASE" --project demo --composition episode-001 --out "$WORK/v1/filmkit.yaml" --json > "$WORK/v1.json"
[ "$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$WORK/v1.json','utf8')).scenes)")" = "100" ] || fail "expected 100 scenes"
[ -f "$WORK/v1/vflow/episode-001@1.bundle.json" ] || fail "no bundle record"

say "the reference image is byte-identical to what vflow serves"
SERVED=$(curl -s "$BASE/v1/projects/demo/assets/preview-png/content" | shasum -a 256 | cut -d' ' -f1)
LANDED=$(shasum -a 256 "$WORK/v1/assets/vflow/${SERVED:0:16}.png" | cut -d' ' -f1)
[ "$SERVED" = "$LANDED" ] || fail "sha256 mismatch: served $SERVED, landed $LANDED"

say "filmkit sees 100 scenes of pending work, nothing else"
(cd "$WORK/v1" && "${FK[@]}" plan --json > "$WORK/v1.plan.json")
PENDING=$(bun -e "const p=JSON.parse(require('fs').readFileSync('$WORK/v1.plan.json','utf8'));console.log(p.nodes.filter(n=>n.executor==='place files').length)")
[ "$PENDING" = "100" ] || fail "expected 100 'place files' nodes, got $PENDING"

say "pull a v2 (reference-authoring) composition: subjects' approved reference packs are read, materials reported"
"${PULL[@]}" pull --base "$BASE" --project reference-test --composition main --out "$WORK/v2/filmkit.yaml" | tee "$WORK/v2.txt"
grep -q "pinned authoring material(s) are not imported" "$WORK/v2.txt" || fail "v2 materials were not reported"
grep -q "ref-face-front" "$WORK/v2/filmkit.yaml" || fail "subject reference pack not imported"

say "place a clip for each scene (the agent's step), then validate and build"
for scene in spell boat; do
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30:duration=1" -pix_fmt yuv420p "$WORK/v2/assets/$scene.mp4"
done
(cd "$WORK/v2" && "${FK[@]}" validate >/dev/null && "${FK[@]}" build --draft >/dev/null)
[ -f "$WORK/v2/build/main.draft.mp4" ] || [ -f "$WORK/v2/build/main.mp4" ] || fail "no video was built"

say "a failing pull leaves the existing project untouched"
cp "$WORK/v2/filmkit.yaml" "$WORK/v2.before"
if "${PULL[@]}" pull --base "$BASE" --project reference-test --composition nope --out "$WORK/v2/filmkit.yaml" --force 2>"$WORK/v2.err"; then fail "pull of a missing composition succeeded"; fi
cmp "$WORK/v2.before" "$WORK/v2/filmkit.yaml" || fail "film changed after a failed pull"
grep -q "not found" "$WORK/v2.err" || fail "expected a not-found error"

say "OK: vflow-pull reads real vflow exports end to end (work dir: $WORK)"
