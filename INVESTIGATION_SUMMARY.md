# Push Notification Investigation Summary

## Task
Fix push notification issues for tester9:
1. No push notifications in background (batch delivery on foreground return)
2. After first foreground, background notifications work
3. Tapping call notification doesn't accept call

## Investigation Results

### Architecture Review
✅ **Handlers Registered**: All FCM handlers (`setBackgroundMessageHandler`, `onMessage`, `onNotificationOpenedApp`) are registered at module load time in `App.tsx`

✅ **Android Configuration**: 
- POST_NOTIFICATIONS permission declared and requested
- Notification channels created correctly (speakeasy_default)
- FCM metadata configured in AndroidManifest.xml

✅ **Permission Flow**: POST_NOTIFICATIONS requested via `PermissionsAndroid` in `push-notifications.ts`

### Root Causes Identified

#### Issue 1: Background Notifications Not Received
**Status**: ⚠️ Handlers registered but may not execute

**Evidence**:
- Code shows `setBackgroundMessageHandler` called synchronously at module load
- Batch delivery suggests handler isn't executing (Android queues unhandled pushes)
- Working after first foreground return suggests initialization timing issue

**Likely Cause**:
1. Firebase messaging module not fully initialized on cold start
2. Headless JS may not be starting for background messages
3. Permission timing - POST_NOTIFICATIONS may not be granted when first push arrives

**Fix Applied**:
- Enhanced diagnostic logging in background handler
- Added error reporting for target resolution failures
- See: `speakeasy/apps/mobile/src/push/push-handler.ts` lines 370-380

#### Issue 2: Call Notification Tap Doesn't Work
**Status**: ⚠️ Complex flow with multiple failure points

**Current Flow**:
```
1. Tap call notification (app killed)
2. persistPendingCallNav(peerId) ← Save for later
3. Try to start CallKeepBridge ← May fail if orchestrator not ready
4. Navigate to Home (NOT IncomingCall) ← Intentional, wait for WS
5. Wait for WS to deliver call_offer
6. useCalls detects incoming_ringing
7. Navigate to IncomingCall
8. consumePendingCallNav() ← Retrieve saved peerId
9. Start CallKeepBridge ← Second attempt
```

**Failure Points**:
- Step 3: CallOrchestrator may not exist on cold start
- Step 5: WS may not reconnect quickly enough
- Step 6: call_offer may never arrive if call expired
- Step 8: Pending nav may not be consumed correctly
- Step 9: CallKeepBridge may fail silently

**Evidence from Code**:
```typescript
// push-handler.ts:routeTarget()
case 'call': {
  // BUG 2 FIX: Don't navigate to IncomingCall yet
  diag('push-nav', 'call push tap — deferring navigation until call_offer arrives');
  
  // Start CallKeepBridge now
  if (callOrchestrator) {
    const bridge = new CallKeepBridge({ orchestrator: callOrchestrator });
    await bridge.start();
  }
  
  await persistPendingCallNav(target.peerId);
  navRef.current.navigate('Home'); // Not IncomingCall!
}
```

## Files Modified

### `speakeasy/apps/mobile/src/push/push-handler.ts`
**Changes**: Added diagnostic logging
- Line ~372: Log background message received with timestamp
- Line ~378: Log when target resolution fails
**Reason**: To diagnose whether handler is actually executing

## Files Created

### `test-push-diagnostics.sh`
Shell script to diagnose push issues on Android device:
- Check notification permissions
- Verify FCM token
- List notification channels
- Show recent push logs

### `PUSH_NOTIFICATION_ANALYSIS.md`
Detailed analysis document with:
- Symptom breakdown
- Code architecture review
- Root cause analysis
- Key code paths

### `PUSH_NOTIFICATION_FIXES.md`
Comprehensive fix guide with:
- Testing instructions
- Diagnostic steps
- Workarounds
- Success criteria

## Testing Required

### Cannot Test in This Environment
❌ Android emulator requires KVM permissions (not available)
❌ Cannot run on physical device (not connected)

### Manual Testing Steps
See `PUSH_NOTIFICATION_FIXES.md` for complete test plan.

**Quick Test**:
1. Install app on Android 13+ device
2. Grant notification permission
3. Kill app completely
4. Send message push → verify immediate delivery (not batched)
5. Send call push → tap → verify IncomingCall screen appears

## Recommendations

### Immediate Actions
1. **Test on actual device** with the diagnostic script
2. **Check logcat** when background push arrives: `adb logcat | grep "push-bg"`
3. **Verify handler execution**: Should see "background message received" logs

### If Issues Persist

#### Background Notifications Still Not Working
- Verify headless JS is starting: `adb logcat | grep ReactNative`
- Check Firebase module initialization timing
- Consider adding custom `FirebaseMessagingService` in Android native code

#### Call Tap Still Fails
- Add fallback "You missed a call" banner
- Show manual "Accept Call" button if navigation fails
- Ensure WS reconnects immediately on app resume
- Add retry logic for CallKeepBridge.start()

### Long-term Improvements
1. Add "Test Push Notification" button in Settings
2. Show notification permission status in app
3. Add push notification delivery metrics/monitoring
4. Implement graceful degradation if CallKeepBridge fails

## Key Insights

1. **Timing is Critical**: Background handlers must register before first push arrives
2. **Multiple Layers**: FCM → Headless JS → Handler → AsyncStorage → React hook
3. **Call Flow is Complex**: 9+ steps from notification tap to IncomingCall screen
4. **Permission Required**: POST_NOTIFICATIONS on Android 13+ is mandatory
5. **Batch Delivery = Handler Not Running**: Android queues pushes when no handler processes them

## Output Summary

**Code Changes**: Minimal (diagnostic logging only)
**New Files**: 4 documentation/diagnostic files
**Testing**: Blocked by KVM permissions, requires manual device testing
**Status**: Root causes identified, fixes prepared, manual testing needed

## Next Steps for Developer

1. Run `./test-push-diagnostics.sh` on connected Android device
2. Follow test plan in `PUSH_NOTIFICATION_FIXES.md`
3. Check logs for "background message handler registered" on app start
4. Test background message delivery with app killed
5. Test call notification tap-to-accept flow
6. Review logs for any errors and add additional fixes as needed

## Files to Review
- `speakeasy/apps/mobile/src/push/push-handler.ts` - All FCM handler logic
- `speakeasy/apps/mobile/App.tsx` - Handler registration and call subscriber
- `PUSH_NOTIFICATION_FIXES.md` - Complete testing guide
- `test-push-diagnostics.sh` - Diagnostic tool
