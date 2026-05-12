#!/bin/bash
# Verify that push notification was received by checking logcat

set -e

echo "Checking logcat for push notification receipt..."

# Search for our diagnostic logs from push-handler.ts
PUSH_LOGS=$(adb logcat -d -s ReactNativeJS:V | grep -i "push-bg\|push-fg\|push-nav\|background message received" | tail -20)

if [ -n "$PUSH_LOGS" ]; then
  echo "✓ Found push handler logs:"
  echo "$PUSH_LOGS" | head -10
else
  echo "⚠ No push handler logs found"
  echo "Checking for FCM logs..."
  FCM_LOGS=$(adb logcat -d | grep -i "FirebaseMessaging\|FCM" | tail -10)
  if [ -n "$FCM_LOGS" ]; then
    echo "Found FCM activity:"
    echo "$FCM_LOGS"
  else
    echo "❌ No FCM or push handler logs found"
    echo "This suggests the background handler did not execute"
  fi
fi

# Check for any errors
ERROR_LOGS=$(adb logcat -d -s ReactNativeJS:E AndroidRuntime:E | grep -i "push\|notification" | tail -10)
if [ -n "$ERROR_LOGS" ]; then
  echo "⚠ Found error logs:"
  echo "$ERROR_LOGS"
fi

echo "✓ Log verification complete"
