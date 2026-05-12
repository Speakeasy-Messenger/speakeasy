# Push Notification Issues - Analysis

## Symptoms (tester9)
1. No push notifications received in background
2. Notifications batch-delivered when returning to foreground  
3. After returning to foreground once, background notifications work
4. Tapping call notification doesn't accept the call

## Root Causes Identified

### Issue 1: Background Notifications Not Received Initially
**Location**: `speakeasy/apps/mobile/src/push/push-handler.ts`

The `setBackgroundMessageHandler` is called at module import time, but there's a race condition:
- Handler must be registered BEFORE any push arrives
- On cold start, the module may load after a push is already queued
- The async fallback takes 50-500ms, missing early pushes

**Fix**: Enhanced logging + verify handler is actually registered before first push

### Issue 2: Batch Delivery on Foreground Return
**Location**: Android system behavior + FCM

When app returns to foreground:
1. Android System delivers all queued notifications
2. `onNotificationOpenedApp` fires for tap
3. `onMessage` fires for any that arrived while backgrounded

This suggests the background handler ISN'T actually running - pushes are queued by Android system instead of being processed by our JS handler.

**Root cause**: The `setBackgroundMessageHandler` call is likely NOT executing in headless JS mode. Possible reasons:
- Firebase messaging module not initialized properly
- Android headless JS not starting the bundle
- Service not configured correctly in AndroidManifest.xml

### Issue 3: Call Notification Tap Doesn't Accept Call
**Location**: `speakeasy/apps/mobile/src/push/push-handler.ts:routeTarget()`

For call taps:
1. Handler persists `PENDING_CALL_NAV_KEY` 
2. Should start CallKeepBridge
3. Navigate to Home (not IncomingCall)
4. Wait for WS to deliver `call_offer`
5. `useCalls` subscriber navigates to IncomingCall

**Problem**: The pending call nav may be consumed but:
- CallOrchestrator might not be initialized
- Call offer might not arrive via WS after tap
- CallKeepBridge start might fail silently

## Key Code Paths

### Background Handler Registration
```typescript
// App.tsx - module level
registerBackgroundMessageHandler();
registerForegroundMessageHandler();
registerNotificationOpenedListener();
```

### Tap Handler Flow
```typescript
// push-handler.ts:routeTarget()
case 'call': {
  // Persist pending nav
  await persistPendingCallNav(target.peerId);
  
  // Try to start CallKeepBridge
  if (callOrchestrator) {
    const bridge = new CallKeepBridge({ orchestrator: callOrchestrator });
    await bridge.start();
  }
  
  // Navigate to Home (NOT IncomingCall)
  navRef.current.navigate('Home');
}
```

### Call Arrival Subscriber
```typescript
// App.tsx
useCalls.subscribe((s, prev) => {
  if (s.active?.stage === 'incoming_ringing' && 
      prev?.active?.stage !== 'incoming_ringing') {
    navRef.current?.navigate('IncomingCall');
    
    // Consume pending call nav and start CallKeepBridge
    const pendingPeer = await consumePendingCallNav();
    if (pendingPeer && callOrch) {
      const bridge = new CallKeepBridge({ orchestrator: callOrch });
      await bridge.start();
    }
  }
});
```

## Tests Needed

### 1. Background Notification Test
- Cold start app
- Kill app completely
- Send message push
- Verify notification appears immediately (not after app resume)

### 2. Call Notification Test  
- Kill app completely
- Send call push
- Tap notification
- Verify:
  - App opens to IncomingCall screen
  - Native ring UI shows
  - Can answer/decline
  - Call audio works

### 3. Permission Test
- Fresh install (no permissions)
- Grant notification permission
- Send push immediately
- Verify it arrives

## Debugging Strategy

1. Add extensive logging to background handler
2. Check Android logcat for FCM messages
3. Verify `setBackgroundMessageHandler` actually registers
4. Check if headless JS is starting
5. Verify POST_NOTIFICATIONS permission is granted
6. Test call acceptance flow end-to-end

## Critical Files
- `speakeasy/apps/mobile/src/push/push-handler.ts` - All FCM handlers
- `speakeasy/apps/mobile/App.tsx` - Handler registration + call subscriber
- `speakeasy/apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/MainActivity.kt` - Notification channels
- `speakeasy/apps/mobile/android/app/src/main/AndroidManifest.xml` - FCM config
