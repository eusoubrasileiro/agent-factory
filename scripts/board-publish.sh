#!/usr/bin/env bash
# board-publish.sh — publish the factory scrumban board HTML to the VPS via rsync.
#
# Usage:
#   pnpm board:publish                              # real publish (rsync over ssh)
#   bash scripts/factory/board-publish.sh --dry-run # offline; print rsync cmd, exit 0
#
# Env overrides:
#   PUBLISH_HOST   SSH host alias (default: deploy-host)
#   PUBLISH_DIR    Remote destination dir, trailing slash (default:
#                  /opt/app/factory/public/)
#
# Preflight: dist/factory-board/index.html must exist (the root project index,
# produced by `pnpm board:report` via `board-autopublish.mjs`). Otherwise exit 1
# with a hint — never attempt the rsync.
#
# The --dry-run path is provably offline: it constructs the rsync command and
# echoes it without spawning ssh or rsync. Tests rely on this guarantee.
set -euo pipefail

DIST_FILE="dist/factory-board/index.html"
DIST_DIR="dist/factory-board/"
HOST="${PUBLISH_HOST:-deploy-host}"
REMOTE_DIR="${PUBLISH_DIR:-/opt/app/factory/public/}"
URL="https://factory.example.com/"

# Preflight: the rendered HTML must exist before we touch the network. Using
# -f (not -e) so a directory in its place is also rejected.
if [[ ! -f "$DIST_FILE" ]]; then
  echo "ERROR: $DIST_FILE not found." >&2
  echo "       Run 'pnpm board:report' first to render the board." >&2
  exit 1
fi

# Build the rsync argv as an array so quoting stays correct even if REMOTE_DIR
# contains spaces. The trailing slash on DIST_DIR means "contents of" — so
# dist/factory-board/* land in REMOTE_DIR rather than REMOTE_DIR/factory-board/.
RSYNC_CMD=(rsync -az --delete "$DIST_DIR" "${HOST}:${REMOTE_DIR}")

if [[ "${1:-}" == "--dry-run" ]]; then
  # Echo the exact command a real run would execute. No ssh, no rsync, no network.
  echo "[dry-run] ${RSYNC_CMD[*]}"
  exit 0
fi

# Real run. set -e propagates any rsync failure.
"${RSYNC_CMD[@]}"
echo "$URL"
