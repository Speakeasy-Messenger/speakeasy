import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native';
import { Platform } from 'react-native';

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
  await notifee.displayNotification({
    id: CALL_NOTIF_ID,
    title: `@${c.peerHandle}`,
    body: c.kind === 'video' ? 'Video call' : 'Voice call',
    android: {
      channelId: CALL_CHANNEL_ID,
      smallIcon: 'ic_notification',
      category: AndroidCategory.CALL,
      importance: AndroidImportance.LOW,
      visibility: AndroidVisibility.PUBLIC,
      // Ongoing + can't-dismiss: a live call shouldn't be swipeable away.
      ongoing: true,
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
    },
  });
}

export async function dismissOngoingCallNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await notifee.cancelNotification(CALL_NOTIF_ID).catch(() => {
    /* best-effort */
  });
}
