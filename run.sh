#!/usr/bin/env bash
# 90-Day Pattern Desk launcher (Git Bash / macOS / Linux)
# Starts the server and opens http://localhost:4949 in your browser.
# Usage:  ./run.sh      (or double-click run.bat on Windows)

set -e
cd "$(dirname "$0")"   # always run from this script's folder

PORT=4949
URL="http://localhost:$PORT"

# --- find node, even if Git Bash's PATH doesn't have it ---
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="node"
else
  for p in \
    "/c/Program Files/nodejs/node.exe" \
    "/c/Program Files (x86)/nodejs/node.exe" \
    "$HOME/AppData/Roaming/npm/node.exe" \
    "/c/Users/$USER/AppData/Local/Programs/nodejs/node.exe"; do
    if [ -x "$p" ]; then NODE="$p"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "Could not find Node.js."
  echo "It works in Command Prompt (you saw v26.4.0) but this Git Bash shell"
  echo "can't see it. Easiest fix: in VS Code, set the default terminal to"
  echo "Command Prompt, or just run  run.bat  instead of this script."
  exit 1
fi

echo "Using Node at: $NODE"
echo "Starting server on $URL ..."

# start the server in the background
"$NODE" server.js &
SERVER_PID=$!

# give it a moment, then open the browser (cross-platform)
sleep 1.5
if command -v cmd.exe >/dev/null 2>&1; then
  cmd.exe /c start "" "$URL" >/dev/null 2>&1 || true   # Windows (Git Bash)
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true               # Linux
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true                   # macOS
fi

echo ""
echo "App is open at $URL"
echo "Press Ctrl+C here to stop the server when you're done."

# stop the server cleanly on Ctrl+C
trap 'echo; echo "Stopping server..."; kill $SERVER_PID 2>/dev/null; exit 0' INT
wait $SERVER_PID
