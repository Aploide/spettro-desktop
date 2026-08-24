#!/usr/bin/env bash
# Shoots every scene in both colour schemes. Kept as a script rather than an
# npm one-liner because CI runs the identical loop — a divergence between what
# a maintainer sees locally and what lands on the pull request is exactly the
# kind of difference nobody notices until it matters.
set -euo pipefail

DIST="${1:-.visual-dist}"
OUT="${2:-.visual-shots}"

SCENES=(
  live
  workflow-running
  workflow-finished
  workflow-wide
  swarm-running
  swarm-finished
  mixed
  studio
  studio:empty
  studio:broken
  chrome
)

rm -rf "$OUT"
for scene in "${SCENES[@]}"; do
  SHOT_THEMES="${SHOT_THEMES:-dark,light}" SHOT_HEIGHT="${SHOT_HEIGHT:-1800}" \
    node_modules/electron/dist/electron --no-sandbox \
    tools/visual/capture.cjs "$DIST" "$OUT" "$scene"
done

echo "$(ls "$OUT" | wc -l) screenshots in $OUT"
