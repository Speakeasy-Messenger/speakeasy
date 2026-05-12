#!/bin/bash
# Send a test FCM message when app is killed
# This tests if headless JS starts and processes the message

set -e

echo "Sending test FCM message to killed app..."

# Method 1: Use adb to trigger FCM receiver
# This simulates what happens when FCM delivers a data-only message
adb shell am startservice \
  -a com.google.firebase.MESSAGING_EVENT \
  -n xyz.speakeasyapp.app/io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService \
  --es "conversation_id" "dm-test-bg" \
  --es "msg_type" "direct" \
  --es "notify_kind" "message" \
  2>&1 || echo "Note: Service start may fail if FCM not configured"

echo "✓ FCM service trigger sent"

# Method 2: Also try broadcast receiver (older FCM versions)
adb shell am broadcast \
  -a com.google.android.c2dm.intent.RECEIVE \
  -n xyz.speakeasyapp.app/io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver \
  --es "google.message_id" "test-msg-$(date +%s)" \
  --es "conversation_id" "dm-test-bg" \
  --es "msg_type" "direct" \
  --es "notify_kind" "message" \
  2>&1 || echo "Note: Broadcast may fail, this is expected"

echo "✓ FCM broadcast sent"

# Give Android time to start headless JS (if it will)
sleep 2
