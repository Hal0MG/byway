#!/bin/sh
# Start Roadtrip Planner on macOS or Linux: run "sh start.sh" in this folder.
# The first time, it installs the parts the app needs (about a minute). Press Ctrl+C to stop the app.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Roadtrip Planner needs Node.js, a free program: https://nodejs.org/en/download"
  echo "Install the LTS version, then run this again."
  exit 1
fi

if [ ! -d node_modules/express ]; then
  echo "First start: installing the app's parts. This takes a minute..."
  npm install --omit=dev || { echo "Installing failed. Check the internet connection and try again."; exit 1; }
fi

echo "Starting Roadtrip Planner at http://localhost:3000 (Ctrl+C to stop)"
node server.js --open
