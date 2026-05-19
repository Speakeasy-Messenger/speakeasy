import { describe, expect, it } from 'vitest';
import { formatDateSeparator, formatMessageTime, isSameLocalDay } from './time.js';

// Anchor reference time: 2026-05-19 14:00 local. Tests construct
// timestamps relative to this so locale and TZ don't flake them.
function localDate(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

const NOW = localDate(2026, 5, 19, 14, 0);

describe('isSameLocalDay', () => {
  it('treats two times on the same calendar day as same', () => {
    expect(isSameLocalDay(localDate(2026, 5, 19, 0, 1), localDate(2026, 5, 19, 23, 59))).toBe(true);
  });
  it('treats midnight rollover as a different day', () => {
    expect(isSameLocalDay(localDate(2026, 5, 19, 23, 59), localDate(2026, 5, 20, 0, 0))).toBe(false);
  });
});

describe('formatMessageTime', () => {
  it('returns a non-empty string containing a digit', () => {
    const out = formatMessageTime(NOW);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(/\d/.test(out)).toBe(true);
  });
});

describe('formatDateSeparator', () => {
  it('returns "Today" for a time on `now`s day', () => {
    expect(formatDateSeparator(localDate(2026, 5, 19, 8, 30), NOW)).toBe('Today');
  });
  it('returns "Yesterday" for the day before `now`', () => {
    expect(formatDateSeparator(localDate(2026, 5, 18, 22, 0), NOW)).toBe('Yesterday');
  });
  it('returns a weekday name for the last six days (excluding today/yesterday)', () => {
    // 4 days ago on a known date.
    const four = localDate(2026, 5, 15, 12, 0);
    const out = formatDateSeparator(four, NOW);
    // Just assert it isn't "Today"/"Yesterday" and isn't a full date.
    // Exact name varies with locale.
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Yesterday');
    expect(/\d/.test(out)).toBe(false);
  });
  it('returns a full date for older entries', () => {
    const old = localDate(2024, 1, 5, 9, 0);
    const out = formatDateSeparator(old, NOW);
    // Includes the year (different from now's year), so a digit appears.
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Yesterday');
    expect(/\d/.test(out)).toBe(true);
  });
});
