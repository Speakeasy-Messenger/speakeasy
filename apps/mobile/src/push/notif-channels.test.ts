import { describe, expect, it } from 'vitest';
import { notifChannelSpec } from './notif-channels.js';

describe('notifChannelSpec', () => {
  it('encodes kind + sound + vibration into a stable, distinct channel id', () => {
    expect(notifChannelSpec('message', true, true).id).toBe('speakeasy_message_s1_v1');
    expect(notifChannelSpec('message', false, true).id).toBe('speakeasy_message_s0_v1');
    expect(notifChannelSpec('message', true, false).id).toBe('speakeasy_message_s1_v0');
    expect(notifChannelSpec('call', false, false).id).toBe('speakeasy_call_s0_v0');
    // Every combination is a different channel (Android can't mutate one).
    const ids = new Set(
      (['message', 'call'] as const).flatMap((k) =>
        [true, false].flatMap((s) => [true, false].map((v) => notifChannelSpec(k, s, v).id)),
      ),
    );
    expect(ids.size).toBe(8);
  });

  it('sets sound:"default" only when sound is on, and vibration verbatim', () => {
    const on = notifChannelSpec('message', true, true);
    expect(on.sound).toBe('default');
    expect(on.vibration).toBe(true);

    const off = notifChannelSpec('message', false, false);
    expect(off.sound).toBeUndefined(); // omitted → silent channel
    expect(off.vibration).toBe(false);
  });

  it('names the channel by kind', () => {
    expect(notifChannelSpec('message', true, true).name).toBe('Messages');
    expect(notifChannelSpec('call', true, true).name).toBe('Calls');
  });
});
