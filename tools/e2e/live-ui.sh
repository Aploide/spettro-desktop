#!/usr/bin/env bash
# Launches the dev app against a real spettro with a scratch profile, runs one
# or more live-ui.cjs scenarios against it, and shuts it down again.
#
#   tools/e2e/live-ui.sh free                  # no tokens: a throwaway HOME
#   tools/e2e/live-ui.sh setup                 # first run: no CLI found
#   REAL_HOME=1 tools/e2e/live-ui.sh hello     # paid: the user's ~/.spettro
#
# Run from the repo root. Shots go to $OUT (default /tmp/sd-live/shots) as
# NN-<name>.png. Environment:
#   SPETTRO_BIN  the CLI (default: ../spettro/bin/spettro — build it with
#                `make build` there; ~/.local/bin/spettro may be stale)
#   PORT         DevTools port (default 9333)
#   PROFILE      Electron user-data dir (default /tmp/sd-live/e2e/userdata);
#                kept between runs, so `reopen` sees the chats `hello` made
#   PROJECT      the folder sessions work in (default /tmp/sd-e2e/proj)
#   REAL_HOME=1  use the real HOME, for the paid scenarios. Those change
#                nothing in ~/.spettro themselves, but anything set in the
#                app (permission, thinking, Ultra) is shared with every
#                session: note the values first and put them back after.
#   SETUP=1      hide every CLI (no explicitCLIPath, ~/.local/bin off PATH,
#                SPETTRO_IGNORE_DEV_CLI=1) to show first-run setup
#
# The app runs in its own process group and the whole group is killed at the
# end, spettro child included — never by a name pattern.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <scenario>… (see: node tools/e2e/live-ui.cjs --list)" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPETTRO_BIN="${SPETTRO_BIN:-$(cd "$ROOT/.." && pwd)/spettro/bin/spettro}"
PORT="${PORT:-9333}"
PROFILE="${PROFILE:-/tmp/sd-live/e2e/userdata}"
PROJECT="${PROJECT:-/tmp/sd-e2e/proj}"
OUT="${OUT:-/tmp/sd-live/shots}"
mkdir -p "$PROFILE" "$PROJECT" "$OUT"

ENV=()
if [ "${SETUP:-}" = 1 ]; then
  HOME_DIR="$(mktemp -d /tmp/sd-live-setup-home.XXXXXX)"
  CLEAN_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "$HOME/.local/bin" | paste -sd: -)"
  ENV=(HOME="$HOME_DIR" PATH="$CLEAN_PATH" SPETTRO_IGNORE_DEV_CLI=1)
  CLI_PATH=""
elif [ "${REAL_HOME:-}" = 1 ]; then
  CLI_PATH="$SPETTRO_BIN"
else
  HOME_DIR="${E2E_HOME:-/tmp/sd-live/e2e/home}"
  mkdir -p "$HOME_DIR"
  ENV=(HOME="$HOME_DIR")
  CLI_PATH="$SPETTRO_BIN"
fi

# A fresh profile points at the CLI and the scratch project; an existing one
# keeps its chats.
if [ ! -f "$PROFILE/preferences.json" ]; then
  printf '{"explicitCLIPath":"%s","lastProjectPath":"%s","recentProjects":["%s"]}\n' \
    "$CLI_PATH" "$PROJECT" "$PROJECT" > "$PROFILE/preferences.json"
fi

cd "$ROOT"
LOG="$OUT/app.log"
setsid env ${ENV[@]+"${ENV[@]}"} npx electron-vite dev --outDir out/e2e --entry out/e2e/main/index.js \
  --remoteDebuggingPort "$PORT" -- --user-data-dir="$PROFILE" > "$LOG" 2>&1 &
APP=$!
stop() { kill -- -"$APP" 2>/dev/null || true; }
trap stop EXIT

for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/json/list" | grep -q '"page"' && break
  sleep 0.5
done
sleep 3 # the window, then the handshake

STATUS=0
for scenario in "$@"; do
  node tools/e2e/live-ui.cjs "$PORT" "$OUT" "$scenario" || STATUS=1
done
exit $STATUS
