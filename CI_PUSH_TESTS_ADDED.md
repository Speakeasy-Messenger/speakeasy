# CI Push Notification Tests - Added

## Summary

Added comprehensive push notification testing to GitHub Actions CI pipeline to diagnose and verify fixes for tester9's issues:
1. Background notifications not received (batch delivery on foreground)
2. Call notification tap doesn't accept call

## Changes Made

### 1. Code Changes

**File: `speakeasy/apps/mobile/src/push/push-handler.ts`**
- Added diagnostic logging for handler registration
- Added timestamp and error context to background message logs
- Lines modified: ~8 lines around registerBackgroundMessageHandler()

### 2. New Maestro Test Flow

**File: `speakeasy/apps/mobile/maestro/11-push-background-handler.yaml`**

Tests the complete background push flow:
1. Enroll tester09
2. Grant POST_NOTIFICATIONS permission
3. Verify handler registered at app start
4. Background the app
5. Kill app completely
6. Send test FCM message
7. Verify headless JS executes handler
8. Relaunch app and verify state

### 3. Test Helper Scripts

Created 6 bash scripts in `speakeasy/apps/mobile/maestro/scripts/`:

**check-handler-registered.sh**
- Checks logcat for "background message handler registered"
- Distinguishes sync vs async registration
- Fails if handler never registered

**grant-notification-permission.sh**
- Grants POST_NOTIFICATIONS on Android 13+
- Verifies permission state via dumpsys
- Handles older Android versions gracefully

**kill-app.sh**
- Force-stops the app completely
- Verifies app is not running
- Prepares for cold-start push test

**send-fcm-test.sh**
- Simulates FCM message via adb (service + broadcast)
- Sends data-only payload (no notification UI)
- Mimics server push format

**verify-headless-execution.sh**
- Checks if headless JS started
- Looks for background handler execution logs
- **PRIMARY DIAGNOSTIC** - This will confirm if handler runs
- Exits with error + context if handler didn't execute

**verify-push-received.sh**
- Alternative verification using logcat search
- Checks for errors
- Shows recent FCM activity

### 4. CI Workflow Updates

**File: `speakeasy/.github/workflows/tier-b-emulator.yml`**

Changes:
1. **Added POST_NOTIFICATIONS grant** after APK install:
   ```bash
   adb shell pm grant xyz.speakeasyapp.app android.permission.POST_NOTIFICATIONS
   ```

2. **Added FCM logcat filters**:
   ```
   RNFirebaseMessaging:V FirebaseMessaging:V
   ```

3. **Added test 11** to the Maestro suite:
   ```bash
   timeout 300 maestro test apps/mobile/maestro/11-push-background-handler.yaml --debug-output /tmp/maestro-11
   ```

## How It Works

### Test Flow

```
1. App launches → Check logs for handler registration
   ↓
2. Kill app → Send FCM test message
   ↓
3. Check logs for:
   - Headless JS start
   - Background handler execution
   - "push-bg: background message received"
   ↓
4. Pass/Fail with diagnostic output
```

### Expected Outcomes

#### ✅ Test Passes
- Handler registered synchronously or asynchronously
- Headless JS starts when FCM message arrives
- Background handler executes and logs message
- **Conclusion**: Issue was permission/timing on tester9's device

#### ❌ Test Fails
- Handler may not register
- Headless JS may not start
- Background handler may not execute
- **Conclusion**: Root cause confirmed, logs show exact failure point

### What We'll Learn

The CI logs will show:

1. **Handler Registration**: 
   - Sync or async?
   - Timing relative to app start?

2. **Headless JS**:
   - Does Android start it for FCM?
   - Does it load the RN bundle?

3. **Handler Execution**:
   - Does setBackgroundMessageHandler callback fire?
   - Does it receive the FCM data payload?

4. **Permission State**:
   - Is POST_NOTIFICATIONS granted?
   - Does it affect delivery?

## Debugging Output

### Success Logs
```
✅ Background handler registered synchronously (ideal)
✓ App killed successfully
✓ FCM broadcast sent
✓ Found headless JS activity
✅ Background handler executed!
```

### Failure Logs
```
❌ No handler registration found in logs
❌ Background handler did NOT execute
This is the PRIMARY BUG: headless JS is not processing background pushes

Possible causes:
1. setBackgroundMessageHandler not registered before message arrived
2. Android not starting headless JS for FCM
3. Firebase messaging module not initialized properly
```

## Next Steps After CI Run

### If Test Passes ✅
- Issue is device/environment specific (not code)
- Check tester9's device permissions
- Verify FCM token is valid
- Check server-side push delivery logs

### If Test Fails ❌
- Root cause confirmed in code/config
- Review CI logs for exact failure point
- Implement fix based on diagnostic output:
  - Handler not registered → Fix module load timing
  - Headless JS not starting → Add Android service config
  - Handler not executing → Fix FCM module initialization

## Manual Testing Still Required

CI tests cover:
- ✅ Handler registration
- ✅ Background push delivery
- ✅ Headless JS execution
- ✅ Permission granting

Still need manual testing for:
- ❌ Call notification tap → acceptance flow (requires WS + CallOrchestrator)
- ❌ Real FCM server integration (CI uses adb simulation)
- ❌ Multi-device scenarios
- ❌ Notification UI/UX verification

## Files Modified/Created

### Modified
- `speakeasy/apps/mobile/src/push/push-handler.ts` (+8 lines)
- `speakeasy/.github/workflows/tier-b-emulator.yml` (+2 tokens: POST_NOTIFICATIONS grant + test 11)

### Created
- `speakeasy/apps/mobile/maestro/11-push-background-handler.yaml` (63 lines)
- `speakeasy/apps/mobile/maestro/scripts/check-handler-registered.sh` (30 lines)
- `speakeasy/apps/mobile/maestro/scripts/grant-notification-permission.sh` (23 lines)
- `speakeasy/apps/mobile/maestro/scripts/kill-app.sh` (19 lines)
- `speakeasy/apps/mobile/maestro/scripts/send-fcm-test.sh` (34 lines)
- `speakeasy/apps/mobile/maestro/scripts/verify-headless-execution.sh` (44 lines)
- `speakeasy/apps/mobile/maestro/scripts/verify-push-received.sh` (34 lines)

Plus documentation:
- `PUSH_NOTIFICATION_ANALYSIS.md` (134 lines)
- `PUSH_NOTIFICATION_FIXES.md` (232 lines)
- `INVESTIGATION_SUMMARY.md` (183 lines)
- `CI_PUSH_TESTS_ADDED.md` (this file)

## Running Tests Locally

### Prerequisites
- Android device/emulator with API 33+
- adb connected
- App built and installed

### Run Full Test
```bash
cd speakeasy/apps/mobile
maestro test maestro/11-push-background-handler.yaml
```

### Run Individual Checks
```bash
# Check handler registration
./maestro/scripts/check-handler-registered.sh

# Grant permission
./maestro/scripts/grant-notification-permission.sh

# Send test push
./maestro/scripts/send-fcm-test.sh

# Verify execution
./maestro/scripts/verify-headless-execution.sh
```

### Watch Logs Live
```bash
adb logcat -s ReactNativeJS:V RNFirebaseMessaging:V FirebaseMessaging:V | grep -i push
```

## Success Criteria

✅ CI test 11 passes
✅ Logs show "background message handler registered"
✅ Logs show "push-bg: background message received" after FCM test
✅ No errors in logcat
✅ App state preserved after background push
✅ Headless JS execution confirmed

## Impact

This test suite will:
1. **Prove or disprove** whether the background handler is actually executing
2. **Pinpoint the exact failure** if handler doesn't execute
3. **Provide reproducible test** for future push notification changes
4. **Catch regressions** in push handling before they reach users
5. **Reduce debug time** by providing CI logs instead of device-specific issues

## Timeline

- Next commit to `main` → CI runs automatically
- CI results available in ~30 minutes
- Logs uploaded to artifacts if test fails
- Can trigger manually via workflow_dispatch
