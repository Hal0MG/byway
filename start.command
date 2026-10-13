#!/bin/sh
# Double-click to start Byway on a Mac. The first time, it installs the parts the app needs (about a minute)
# and opens the app in your browser. Keep this window open while you use the app; close it to stop the app.
# If macOS says it can't be opened: right-click it, choose Open, then Open again (only needed once).
cd "$(dirname "$0")" || exit 1
exec sh ./start.sh
