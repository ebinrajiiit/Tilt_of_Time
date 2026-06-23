#!/usr/bin/env bash
# Tilt of Time — stall launcher. Serves this folder on localhost and opens it.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8090}"
URL="http://localhost:${PORT}"
echo ""
echo "  🏮  Tilt of Time is serving at:  ${URL}"
echo "      Open it in Chrome/Edge and allow camera access. Press F for fullscreen."
echo "      (Ctrl+C to stop)"
echo ""
# Try to open a browser (macOS / Linux), non-fatal if it fails.
( sleep 1; command -v open >/dev/null && open "${URL}" || command -v xdg-open >/dev/null && xdg-open "${URL}" ) >/dev/null 2>&1 &
exec python3 serve.py "${PORT}"
