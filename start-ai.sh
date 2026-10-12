#!/bin/sh
# Starts LM Studio's local server and loads the planning model (macOS and Linux). The Setup screen in the app can do
# this too. Run it after a restart if planning says LM Studio isn't running.
LMS="$HOME/.lmstudio/bin/lms"
MODEL="qwen/qwen3.5-9b"
if [ ! -x "$LMS" ]; then
  echo "LM Studio's command line tool wasn't found at $LMS. Install LM Studio (lmstudio.ai), open it once, then try again."
  exit 1
fi
"$LMS" server start
"$LMS" unload --all >/dev/null 2>&1
"$LMS" load "$MODEL" --context-length 32768 --gpu max -y
echo
echo "Ready. Plan a trip in the app."
