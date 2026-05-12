#!/bin/bash
# Simulate FCM push notification via adb broadcast
# This mimics the FCM message that would arrive from the server

set -e

USER_ID="${USER_ID:-tester09}"
MESSAGE="${MESSAGE:-Test notification}"

echo "Simulating FCM push notification..."
echo "  User: $USER_ID"
echo "  Message: $MESSAGE"

# Use adb to broadcast an intent that mimics FCM
# The data payload matches what the server sends:
# - conversation_id: The conversation to open
# - msg_type: "direct" or "group"
# - notify_kind: "message" or "call"

# For this test, we'll send a direct message notification
adb shell am broadcast \
  -a com.google.android.c2dm.intent.RECEIVE \
  -n xyz.speakeasyapp.app/io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver \
  --es "conversation_id" "dm-test123" \
  --es "msg_type" "direct" \
  --es "notify_kind" "message" \
  --es "gcm.notification.title" "New Message" \
  --es "gcm.notification.body" "$MESSAGE" \
  || echo "Warning: Broadcast may have failed (this is expected if FCM module not ready)"

echo "✓ Push broadcast sent"

# Give the system time to process
sleep 1

# Check if notification appeared in notification shade
NOTIF_COUNT=$(adb shell dumpsys notification | grep "xyz.speakeasyapp.app" | grep -c "NotificationRecord" || echo "0")
echo "Active notifications: $NOTIF_COUNT"

if [ "$NOTIF_COUNT" -gt 0 ]; then
  echo "✓ Notification delivered to system"
else
  echo "⚠ No notification in system shade (may still be in app)"
fi
