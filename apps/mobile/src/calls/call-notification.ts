import notifee, {
  AndroidCategory,
  AndroidForegroundServiceType,
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import { diag } from '../diag/log.js';

/**
 * The "voice-call pill": an ongoing Android notification shown while a call
 * is active and the app is backgrounded — WhatsApp-style. Shows the peer, a
 * live duration, Mute/End actions, and tap-to-return. Video calls float into
 * a PiP bubble instead, so this is primarily the affordance for AUDIO calls
 * (which have nothing visible when backgrounded), but it works for any kind.
 *
 * iOS gets this for free from CallKit's system call UI (see CallKeepBridge);
 * this module is Android-only.
 *
 * Action pressAction ids are handled by the notifee event listener wired in
 * App.tsx (foreground) — they route to the orchestrator's mute/hangup and
 * bring the call screen back.
 */
const CALL_NOTIF_ID = 'speakeasy-active-call';
const CALL_CHANNEL_ID = 'active-call';

export const CALL_NOTIF_ACTIONS = {
  mute: 'call-mute',
  end: 'call-end',
  return: 'return-to-call',
} as const;

export interface OngoingCallNotif {
  peerHandle: string;
  /** ms epoch when the call connected; drives the live duration counter. */
  connectedAtMs?: number;
  micMuted: boolean;
  kind: 'audio' | 'video' | 'private';
}

export async function showOngoingCallNotification(c: OngoingCallNotif): Promise<void> {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: CALL_CHANNEL_ID,
    name: 'Active call',
    // LOW so the ongoing pill doesn't buzz/peek on every update (mute toggle).
    importance: AndroidImportance.LOW,
    vibration: false,
  });
  const android = {
    channelId: CALL_CHANNEL_ID,
    smallIcon: 'ic_notification',
    category: AndroidCategory.CALL,
    importance: AndroidImportance.LOW,
    visibility: AndroidVisibility.PUBLIC,
    // Ongoing + can't-dismiss: a live call shouldn't be swipeable away.
    ongoing: true as const,
    autoCancel: false,
    onlyAlertOnce: true,
    // Live duration counter (counts up from connect time).
    ...(c.connectedAtMs
      ? { timestamp: c.connectedAtMs, showChronometer: true, showTimestamp: true }
      : {}),
    // Tap the body → reopen the call screen.
    pressAction: { id: CALL_NOTIF_ACTIONS.return, launchActivity: 'default' },
    actions: [
      { title: c.micMuted ? 'Unmute' : 'Mute', pressAction: { id: CALL_NOTIF_ACTIONS.mute } },
      { title: 'End', pressAction: { id: CALL_NOTIF_ACTIONS.end } },
    ],
  };
  const base = {
    id: CALL_NOTIF_ID,
    title: `@${c.peerHandle}`,
    body: c.kind === 'video' ? 'Video call' : 'Voice call',
  };
  try {
    // Post as a FOREGROUND SERVICE. A plain ongoing notification is not enough
    // on One UI / Android 14: the OS freezes & kills a backgrounded audio call
    // within seconds, which both drops the call's WS and removes the pill (the
    // reported "pill never shows on Android"). The FGS holds the process. The
    // mic is live (RECORD_AUDIO) so `microphone` is the right, allowed type;
    // posting happens at call-connect while foreground, so the Android-14
    // background-start restriction doesn't apply.
    await notifee.displayNotification({
      ...base,
      android: {
        ...android,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE],
      },
    });
  } catch (err) {
    // Rare edge: a call answered from the background can't legally START a
    // microphone FGS (Android 14). Don't crash — fall back to a plain ongoing
    // pill so there's still SOMETHING controllable, and leave a breadcrumb.
    diag('call', 'pill FGS start failed; plain fallback', { err: String(err) });
    await notifee.displayNotification({ ...base, android }).catch((err2) => {
      diag('call', 'pill plain display failed', { err: String(err2) });
    });
  }
}

export async function dismissOngoingCallNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Stop the foreground service first (it's what's holding the process alive);
  // cancelling the notification alone can leave the service lingering. Both are
  // best-effort + idempotent — no-ops if the pill was the plain-fallback kind.
  await notifee.stopForegroundService().catch(() => {
    /* best-effort */
  });
  await notifee.cancelNotification(CALL_NOTIF_ID).catch(() => {
    /* best-effort */
  });
}
