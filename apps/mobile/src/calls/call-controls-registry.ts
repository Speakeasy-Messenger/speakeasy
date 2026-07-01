/**
 * A tiny process-global handle to the CURRENTLY-ACTIVE call's controls.
 *
 * Why this exists: the ongoing-call pill's Mute / End actions (see
 * call-notification.ts) are pressed while the app is BACKGROUNDED — which is the
 * whole point of the pill. notifee delivers backgrounded action presses to
 * `onBackgroundEvent` (in push-handler.ts), NOT to App.tsx's `onForegroundEvent`,
 * so wiring the actions only in the foreground handler left the pill buttons
 * dead. The CallOrchestrator lives as a closure inside App.tsx with no export,
 * so the background handler can't reach it directly.
 *
 * The call keeps the process alive (foreground service), so the SAME JS context
 * is running when the background event fires — App.tsx just publishes the live
 * call's mute/hangup here while a call is active, and the background handler
 * looks them up at press time. Cleared on call teardown so a stale press is a
 * no-op.
 */
export interface ActiveCallControls {
  /** Toggle the mic mute state of the active call. */
  toggleMute: () => void;
  /** Hang up the active call and drop the pill. */
  hangup: () => void;
}

let controls: ActiveCallControls | undefined;

export function setActiveCallControls(next: ActiveCallControls | undefined): void {
  controls = next;
}

export function getActiveCallControls(): ActiveCallControls | undefined {
  return controls;
}
