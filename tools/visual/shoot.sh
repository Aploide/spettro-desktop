#!/usr/bin/env bash
# Shoots every scene in both colour schemes. Kept as a script rather than an
# npm one-liner because CI runs the identical loop — a divergence between what
# a maintainer sees locally and what lands on the pull request is exactly the
# kind of difference nobody notices until it matters.
set -euo pipefail

DIST="${1:-.visual-dist}"
OUT="${2:-.visual-shots}"

# Electron 43 has no postinstall. It exposes its downloader as a `bin`
# (`install-electron`) instead, so a plain `npm ci` deliberately does not fetch
# the ~100MB runtime — which is right for a repo where most installs never
# launch it, and fatal for a script that assumed the binary was simply there.
# Resolve it the way the electron package intends, and fetch it if this is one
# of the installs that does need it.
#
# `require('electron')` returns the path whether or not the file exists, so the
# existence check has to be separate from the resolve.
resolve_electron() {
  node -p "try { require('electron') } catch (e) { '' }" 2>/dev/null
}

ELECTRON="$(resolve_electron)"
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "electron runtime not present; downloading it once…"
  node node_modules/electron/install.js
  ELECTRON="$(resolve_electron)"
fi
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "could not obtain the electron runtime" >&2
  exit 1
fi

SCENES=(
  live
  workflow-running
  workflow-finished
  workflow-wide
  workflow-paused
  workflow-stopped
  workflow-continued
  workflow-detail
  mixed
  studio
  studio:empty
  studio:broken
  chrome
  chrome:thinking
  chrome:meteor
  app:welcome
  app:welcome-empty
  app:welcome-folders
  app:chat
  app:chat-tools
  app:chat-error
  app:chat-steering
  app:busy
  app:guide
  app:ultra
  app:slash
  app:mention
  app:model-menu
  app:session-settings
  app:thinking
  app:thinking-paused
  app:sidebar-many
  app:sidebar-menu
  app:collapsed
  app:switcher
  app:permission-bash
  app:permission-diff
  app:permission-compact
  app:permission-denied
  app:permission-orphan
  app:question
  app:question-multi
  app:settings
  app:onboarding
  app:gate
  app:failure
)

THEMES="${SHOT_THEMES:-dark,light}"
# One file per scene per theme; derived from the list actually being shot so a
# deliberate single-theme run is not mistaken for a failure.
THEME_COUNT="$(printf '%s' "$THEMES" | awk -F, '{print NF}')"

rm -rf "$OUT"
for scene in "${SCENES[@]}"; do
  SHOT_THEMES="$THEMES" SHOT_HEIGHT="${SHOT_HEIGHT:-1800}" \
    "$ELECTRON" --no-sandbox tools/visual/capture.cjs "$DIST" "$OUT" "$scene"
done

COUNT="$(ls "$OUT" | wc -l)"
EXPECTED=$(( ${#SCENES[@]} * THEME_COUNT ))
echo "$COUNT screenshots in $OUT"
# Every bug this tool has had produced *fewer files while reporting success* —
# a window-lifetime mistake that silently dropped one whole colour scheme, and
# a missing runtime. The count is checked rather than trusted.
if [ "$COUNT" -ne "$EXPECTED" ]; then
  echo "expected $EXPECTED (${#SCENES[@]} scenes x $THEME_COUNT scheme(s))" >&2
  exit 1
fi
