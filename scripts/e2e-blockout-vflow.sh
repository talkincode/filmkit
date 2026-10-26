#!/usr/bin/env bash
# L0 end-to-end with BOTH real render engines, then local vflow MCP/REST lifecycle
# and filmkit consumption. No production data or model API calls. Results remain
# under WORK for full-playback human review; synthetic approvals are test-only.
# VFLOW_DIR=../vflow BLOCKOUT_HYPERFRAMES=/path/to/hyperframes bash scripts/e2e-blockout-vflow.sh [WORK]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
cd "$ROOT"
SCENE=tools/vflow/test/fixtures/blockout-vflow-scene.json
BINDINGS=tools/vflow/test/fixtures/blockout-vflow-bindings.json
for engine in blender three; do
  echo "== $engine: validate + render reference bundle with real seek verification"
  bun tools/blockout/bin/blockout.ts doctor --engine "$engine" --json
  bun tools/blockout/bin/blockout.ts render "$SCENE" --engine "$engine" --out "$WORK/$engine" --seek-samples 3 --json > "$WORK/$engine-result.json"
  bun tools/vflow/bin/vflow-pull.ts package-motion "$WORK/$engine/manifest.json" --binding "$BINDINGS" --out "$WORK/$engine/package.json" --json > "$WORK/$engine-package.json"
  BLOCKOUT_MANIFEST="$WORK/$engine/manifest.json" bun scripts/e2e-motion-reference.ts
  echo "OK $engine: reference.mp4, overview.png, keyframes, source archive, manifest → approved fixture → input/evidence → filmkit refs"
done
echo "L0 integration passed. Review videos at $WORK/{blender,three}/reference.mp4; these are fixtures, NOT approved production references."
