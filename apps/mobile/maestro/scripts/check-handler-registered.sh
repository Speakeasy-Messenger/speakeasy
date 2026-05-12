#!/bin/bash
# Check if background message handler was registered

set -e

echo "Checking if background message handler was registered..."

# Wait a moment for logs to flush
sleep 2

# Look for our diagnostic log from push-handler.ts
HANDLER_LOG=$(adb logcat -d -s ReactNativeJS:V | grep "background message handler registered" || echo "")

if echo "$HANDLER_LOG" | grep -q "sync"; then
  echo "✅ Background handler registered synchronously (ideal)"
  echo "$HANDLER_LOG" | head -3
  exit 0
elif echo "$HANDLER_LOG" | grep -q "async"; then
  echo "⚠️  Background handler registered asynchronously (may miss early pushes)"
  echo "$HANDLER_LOG" | head -3
  exit 0
else
  echo "❌ No handler registration found in logs"
  echo ""
  echo "Recent ReactNativeJS logs:"
  adb logcat -d -s ReactNativeJS:V | tail -30
  echo ""
  echo "This suggests registerBackgroundMessageHandler() was not called"
  exit 1
fi
