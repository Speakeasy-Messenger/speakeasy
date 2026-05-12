#!/bin/bash
# Kill the app completely to test cold-start push delivery

set -e

echo "Killing app completely..."

adb shell am force-stop xyz.speakeasyapp.app

# Verify app is not running
RUNNING=$(adb shell "ps | grep xyz.speakeasyapp.app" || echo "")

if [ -z "$RUNNING" ]; then
  echo "✓ App killed successfully"
else
  echo "⚠ App may still be running: $RUNNING"
fi

sleep 1
