/**
 * EventLatch — the sender-side burst-repeat that makes one-shot acoustic
 * events survive the unreliable ({ ordered:false, maxRetransmits:0 })
 * animation data channel.
 *
 * Regression target: the rc.78 on-device report where a friend's laugh
 * either didn't register or squinted the avatar ~10 s late. Root cause —
 * the detector fires on ~one window then cools down ~2 s, so the laugh
 * rode a single frame; one drop and it was gone. The latch re-sends it
 * for a short burst so at least one copy lands.
 */
import { describe, expect, it } from 'vitest';
import { EventLatch } from './feature-event-listener.js';
import type { AcousticEvent } from './audio-feature-extractor.js';

describe('EventLatch', () => {
  it('repeats a detected event across the latch window of "none" frames', () => {
    const latch = new EventLatch();
    const out: AcousticEvent[] = [];
    out.push(latch.push('laugh')); // detection frame
    for (let i = 0; i < 12; i++) out.push(latch.push('none')); // cooldown
    // The detection frame + 8 latched repeats = 9 copies of 'laugh'.
    const laughs = out.filter((e) => e === 'laugh').length;
    expect(laughs).toBe(9);
    // After the burst is spent it falls back to 'none'.
    expect(out[out.length - 1]).toBe('none');
  });

  it('passes through "none" when nothing has fired', () => {
    const latch = new EventLatch();
    for (let i = 0; i < 5; i++) expect(latch.push('none')).toBe('none');
  });

  it('re-arms on a fresh detection, restarting the burst', () => {
    const latch = new EventLatch();
    latch.push('laugh');
    latch.push('none');
    latch.push('none');
    // A new event mid-latch takes over and resets the countdown.
    expect(latch.push('gasp')).toBe('gasp');
    const tail: AcousticEvent[] = [];
    for (let i = 0; i < 8; i++) tail.push(latch.push('none'));
    expect(tail.every((e) => e === 'gasp')).toBe(true);
  });

  it('reset() clears the latch so a new call starts clean', () => {
    const latch = new EventLatch();
    latch.push('laugh');
    latch.reset();
    // No leftover repeats leak into the next call.
    expect(latch.push('none')).toBe('none');
  });
});
