/**
 * Native module bridge for posting MessagingStyle notifications with
 * runtime-cached avatar PNGs. Bypasses notifee because notifee's
 * bundled Fresco pipeline silently drops every URI scheme we tried for
 * the avatar (file://, data:, content://). See
 * `xyz.speakeasyapp.app.notif.NotifMessagingModule` for the Kotlin
 * side.
 *
 * iOS path is a no-op for now — the messaging-notification flow is
 * Android-only (FCM headless display). When iOS lands its own
 * APNs-backed messaging notification, this is the place to wire it.
 */

import { NativeModules, Platform } from 'react-native';

interface NativeNotifMessagingModule {
  displayMessagingNotification(args: {
    conversationId: string;
    channelId?: string;
    peerHandle: string;
    /** Absolute path to the SENDER's avatar PNG — the per-message Person icon. */
    peerAvatarPath?: string | null;
    /**
     * Absolute path to the CONVERSATION icon PNG (the room mark for a group,
     * the peer for 1:1) — the collapsed banner + Conversation-shortcut icon.
     * When absent the native side falls back to `peerAvatarPath`.
     */
    conversationAvatarPath?: string | null;
    /** Absolute filesystem path to the local user's cached avatar PNG. */
    selfAvatarPath?: string | null;
    withReply: boolean;
    title?: string;
    body?: string;
    msgType: string;
    messages: Array<{
      text: string;
      timestamp: number;
      isFromPeer: boolean;
    }>;
  }): Promise<{
    success: boolean;
    peerBitmapLoaded: boolean;
    selfBitmapLoaded: boolean;
  }>;

  cancelNotification(conversationId: string): Promise<void>;

  /** Returns the tap target stashed by MainActivity, or null. */
  consumePendingTap(): Promise<{
    conversation_id: string;
    notify_kind: string;
    msg_type: string;
    sender_id: string;
  } | null>;
}

function module(): NativeNotifMessagingModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  const m = (NativeModules as Record<string, unknown>)['SpeakeasyNotifMessaging'];
  return m as NativeNotifMessagingModule | undefined;
}

export const NotifMessaging = {
  available(): boolean {
    return module() !== undefined;
  },
  display: (
    args: Parameters<NativeNotifMessagingModule['displayMessagingNotification']>[0],
  ) => module()?.displayMessagingNotification(args),
  cancel: (conversationId: string) => module()?.cancelNotification(conversationId),
  consumePendingTap: async () => {
    const m = module();
    if (!m) return null;
    return m.consumePendingTap();
  },
};
