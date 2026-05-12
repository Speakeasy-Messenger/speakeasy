#!/bin/bash
# Grant POST_NOTIFICATIONS permission for Android 13+
# Required for push notifications to work

set -e

echo "Granting POST_NOTIFICATIONS permission..."

# Check Android API level
API_LEVEL=$(adb shell getprop ro.build.version.sdk)

if [ "$API_LEVEL" -ge 33 ]; then
  echo "Android API $API_LEVEL detected, granting POST_NOTIFICATIONS"
  adb shell pm grant xyz.speakeasyapp.app android.permission.POST_NOTIFICATIONS || true
else
  echo "Android API $API_LEVEL does not require POST_NOTIFICATIONS"
fi

# Verify permission was granted
PERM_STATE=$(adb shell dumpsys package xyz.speakeasyapp.app | grep "android.permission.POST_NOTIFICATIONS" || echo "not found")
echo "Permission state: $PERM_STATE"

echo "✓ Notification permission granted"
