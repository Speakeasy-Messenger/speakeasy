/**
 * Notification channel resolution for the Sound + Vibration toggles (#10).
 *
 * Android 8+ bakes sound and vibration into the notification CHANNEL at
 * creation time and ignores any later change to an existing channel. So
 * to honor a per-app toggle we can't mutate one channel — each
 * (kind, sound, vibration) combination gets its own immutable channel id,
 * and the push handler lazily creates the one the current settings call
 * for. Typical users keep defaults, so only `*_s1_v1` ever exists; a user
 * who toggles spawns at most a few more.
 *
 * `sound: 'default'` plays the system notification sound; omitting `sound`
 * makes the channel silent. (`importance` is added by the handler so this
 * module stays free of the notifee import and is unit-testable.)
 */

export type NotifKind = 'message' | 'call';

export interface ChannelSpec {
  id: string;
  name: string;
  vibration: boolean;
  sound?: 'default';
}

export function notifChannelSpec(
  kind: NotifKind,
  sound: boolean,
  vibration: boolean,
): ChannelSpec {
  return {
    id: `speakeasy_${kind}_s${sound ? 1 : 0}_v${vibration ? 1 : 0}`,
    name: kind === 'call' ? 'Calls' : 'Messages',
    vibration,
    ...(sound ? { sound: 'default' as const } : {}),
  };
}
