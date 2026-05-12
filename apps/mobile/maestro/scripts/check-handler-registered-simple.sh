#!/bin/bash
# Check if background message handler was registered (SIMPLE VERSION)
# Just greps logcat, doesn't require specific tags

set -e

echo "Checking if background message handler was registered..."

# Wait a moment for logs to flush
sleep 2

# Look for our diagnostic log from push-handler.ts
# Search ALL logs, not just ReactNativeJS tag
HANDLER_LOG=$(adb logcat -d | grep "background message handler registered" || echo "")

if echo "$HANDLER_LOG" | grep -q "sync"; then
  echo "✅ Background handler registered synchronously!"
  echo "$HANDLER_LOG" | head -3
  exit 0
elif echo "$HANDLER_LOG" | grep -q "async"; then
  echo "✅ Background handler registered asynchronously"
  echo "$HANDLER_LOG" | head -3
  exit 0
else
  echo "❌ No handler registration found in logs"
  echo ""
  echo "Searching for ANY push-related logs..."
  adb logcat -d | grep -i "push\|firebase\|fcm" | tail -20 || echo "  No push logs found"
  echo ""
  echo "Searching for app startup logs..."
  adb logcat -d | grep -i "speakeasy\|ReactNative" | tail -20 || echo "  No app logs found"
  echo ""
  echo "This suggests:"
  echo "1. App didn't launch successfully, OR"
  echo "2. registerBackgroundMessageHandler() was not called, OR"  
  echo "3. Logcat filter is wrong"
  exit 1
fi
