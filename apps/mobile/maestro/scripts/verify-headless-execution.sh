#!/bin/bash
# Verify that headless JS started and background handler executed

set -e

echo "Checking if headless JS executed background handler..."

# Clear any old logs first by getting timestamp of when we started waiting
START_TIME=$(date +%s)

# Wait a bit more for headless JS
sleep 3

# Look for evidence that headless JS started
HEADLESS_START=$(adb logcat -d -t "$START_TIME" | grep -i "HeadlessJsTaskService\|ReactNative.*Starting\|RNFirebaseMessaging" || echo "")

if [ -n "$HEADLESS_START" ]; then
  echo "✓ Found headless JS activity:"
  echo "$HEADLESS_START" | head -5
else
  echo "⚠ No headless JS activity found"
fi

# Look for our background handler logs
BG_HANDLER=$(adb logcat -d -t "$START_TIME" | grep "push-bg.*background message received" || echo "")

if [ -n "$BG_HANDLER" ]; then
  echo "✅ Background handler executed!"
  echo "$BG_HANDLER"
  exit 0
else
  echo "❌ Background handler did NOT execute"
  echo ""
  echo "This is the PRIMARY BUG: headless JS is not processing background pushes"
  echo ""
  echo "Recent logs:"
  adb logcat -d -t "$START_TIME" -s ReactNativeJS:V RNFirebaseMessaging:V FirebaseMessaging:V | tail -20
  echo ""
  echo "Possible causes:"
  echo "1. setBackgroundMessageHandler not registered before message arrived"
  echo "2. Android not starting headless JS for FCM"
  echo "3. Firebase messaging module not initialized properly"
  exit 1
fi
