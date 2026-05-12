# Push Notification Fixes for tester9

## Issues Identified

### Issue 1: Background Notifications Not Received
**Symptom**: No push notifications when app is backgrounded/killed. They batch-deliver on return to foreground.

**Root Cause**: The `setBackgroundMessageHandler` is registered, but the handler may not be executing in headless JS mode due to:
1. Timing issues with Firebase module initialization
2. Android not starting headless JS for background notifications
3. POST_NOTIFICATIONS permission not granted on Android 13+

**Fix Applied**:
- Added diagnostic logging to confirm handler registration
- Enhanced error reporting when target resolution fails
- Code location: `speakeasy/apps/mobile/src/push/push-handler.ts`

### Issue 2: Call Notification Tap Doesn't Accept Call
**Symptom**: Tapping a call notification opens the app but doesn't show IncomingCall screen or accept the call.

**Root Cause**: The call acceptance flow has multiple failure points:
1. `resolveTarget()` may fail if conversation store not hydrated
2. CallOrchestrator may not be initialized when push is tapped
3. CallKeepBridge start may fail silently
4. WS may not deliver `call_offer` after app resumes

**Current Flow** (from code review):
```
Tap call notification
  → persistPendingCallNav(peerId)
  → Start CallKeepBridge (if orchestrator exists)
  → Navigate to Home
  → Wait for WS call_offer
  → useCalls subscriber detects incoming_ringing
  → Navigate to IncomingCall
  → Consume pending call nav
  → Start CallKeepBridge again
```

## Testing Instructions

### Prerequisites
1. Android device/emulator with API 33+ (Android 13+)
2. Google Play Services installed (for FCM)
3. App built and installed: `cd speakeasy/apps/mobile && npm run android`

### Test 1: Background Message Notifications

```bash
# 1. Launch app and log in
# 2. Grant notification permission when prompted
# 3. Send app to background (home button)
# 4. From server, send a message push to tester9's FCM token
# 5. Verify notification appears immediately (not batched)

# Check logs:
adb logcat | grep -i "push-bg\|fcm\|notification"

# Expected logs:
# push-bg: background message received
# push-bg: tap-target persisted
```

### Test 2: Call Notification Acceptance

```bash
# 1. Kill app completely (swipe from recents)
# 2. From server, send a call push to tester9's FCM token
# 3. Tap the notification
# 4. Verify:
#    - App opens to IncomingCall screen
#    - Native ring UI shows
#    - Can answer call
#    - Audio works

# Check logs:
adb logcat | grep -i "push-bg\|call\|callkeep"

# Expected logs:
# push-bg: background message received
# push-bg: tap-target persisted (kind: call)
# push-nav: call push tap — deferring navigation
# callkeep: starting CallKeepBridge
# app: pending call nav consumed
```

### Test 3: Permission Flow

```bash
# 1. Fresh install (uninstall first)
adb uninstall xyz.speakeasyapp.app

# 2. Install and launch
cd speakeasy/apps/mobile && npm run android

# 3. Check permission state
adb shell dumpsys package xyz.speakeasyapp.app | grep POST_NOTIFICATIONS

# 4. Grant permission via Settings if not auto-prompted
# 5. Send test push immediately after granting
# 6. Verify it arrives
```

## Diagnostic Script

Run `./test-push-diagnostics.sh` to check:
- Device connection
- Notification permission status
- POST_NOTIFICATIONS permission
- FCM token registration
- Notification channels
- Recent push logs

## Known Issues & Workarounds

### Issue: Batch Delivery After First Foreground
**Observation**: After returning to foreground once, background notifications work correctly.

**Likely Cause**: The Firebase messaging module isn't fully initialized on cold start. The foreground return triggers full initialization, after which background handler works.

**Workaround**: 
- Ensure user opens app at least once after installation
- Consider adding a "Test Notifications" button in Settings that sends a test push

### Issue: Call Tap Doesn't Work First Time
**Observation**: First call notification tap may not work, but subsequent ones do.

**Likely Cause**: 
1. CallOrchestrator not initialized on cold start
2. WS connection not established yet
3. Conversation store not hydrated to resolve peerId

**Workaround**:
- Retry call if first tap fails
- Add fallback to show "Incoming Call" banner with manual accept button

## Additional Debugging

### Enable Firebase Debug Logging

```bash
# Enable FCM debug logs
adb shell setprop log.tag.FA VERBOSE
adb shell setprop log.tag.FA-SVC VERBOSE
adb shell setprop log.tag.FirebaseMessaging VERBOSE

# View logs
adb logcat -v time -s FA FA-SVC FirebaseMessaging
```

### Check Background Handler Registration

```bash
# Search for handler registration logs
adb logcat -d | grep "background message handler registered"

# Expected output:
# push: background message handler registered (sync)
# OR
# push: background message handler registered (async fallback)
```

### Verify Notification Channels

```bash
# List all notification channels
adb shell dumpsys notification | grep "xyz.speakeasyapp.app" -A 50

# Should see:
# - speakeasy_default (Messages channel)
# - xyz.speakeasyapp.app.calls (CallKeep channel)
```

## Next Steps If Issues Persist

1. **Background handler not executing**:
   - Check if Android is starting headless JS: `adb logcat | grep "ReactNative\|RNFirebaseMessaging"`
   - Verify module load timing: Add log at top of `index.js`
   - Consider adding Android `FirebaseMessagingService` override

2. **Call tap flow breaking**:
   - Add diagnostics to `consumePendingCallNav()`
   - Log CallOrchestrator initialization state
   - Check WS connection state when call arrives
   - Add fallback UI for "missed" call taps

3. **Permission issues**:
   - Verify `PermissionsAndroid.request` is called for POST_NOTIFICATIONS
   - Check timing of permission request vs FCM token registration
   - Add permission status indicator in app Settings

## Code Changes Made

### File: `speakeasy/apps/mobile/src/push/push-handler.ts`

**Changes**:
1. Added diagnostic logging when handler is called
2. Enhanced error logging when target resolution fails  
3. Added timestamp to background message logs

**Lines changed**: 8 lines (around line 370-390)

### File: `test-push-diagnostics.sh` (NEW)

**Purpose**: Shell script to diagnose push notification issues on connected Android device

**Usage**: `./test-push-diagnostics.sh`

### File: `PUSH_NOTIFICATION_ANALYSIS.md` (NEW)

**Purpose**: Detailed analysis of issues, code paths, and architecture

## Manual Testing Checklist

- [ ] Fresh install on Android 13+ device
- [ ] Grant POST_NOTIFICATIONS permission
- [ ] Send message push with app backgrounded → verify immediate delivery
- [ ] Send message push with app killed → verify immediate delivery
- [ ] Send call push with app killed → tap → verify IncomingCall screen
- [ ] Send call push with app backgrounded → tap → verify IncomingCall screen
- [ ] Answer call from push notification → verify audio works
- [ ] Decline call from push notification → verify app returns to correct screen
- [ ] Check logs for any errors/warnings
- [ ] Verify push token is registered on server

## Success Criteria

✅ Background message pushes appear immediately (no batching)
✅ Call notification tap opens IncomingCall screen
✅ Can answer/decline call from notification
✅ Call audio works after accepting from notification
✅ No errors in logs related to push/FCM/CallKeep
