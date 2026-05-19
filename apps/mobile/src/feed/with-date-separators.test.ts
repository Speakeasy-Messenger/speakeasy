import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../store/conversations.js';
import { withDateSeparators } from './with-date-separators.js';

function localDate(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function msg(id: string, sentAt: number): ChatMessage {
  return {
    id,
    from: 'silent-golden-hawk',
    text: 'hi',
    kind: 'direct',
    sentAt,
    stage: 'sent',
  };
}

describe('withDateSeparators', () => {
  it('returns [] for an empty list', () => {
    expect(withDateSeparators([])).toEqual([]);
  });

  it('drops a separator at the very end so a single-day thread gets a label', () => {
    const m1 = msg('m1', localDate(2026, 5, 19, 8, 0));
    const m2 = msg('m2', localDate(2026, 5, 19, 9, 0));
    // Newest-first.
    const feed = withDateSeparators([m2, m1]);
    expect(feed).toHaveLength(3);
    expect(feed[0]).toBe(m2);
    expect(feed[1]).toBe(m1);
    expect(feed[2]).toMatchObject({ kind: 'date-separator', sentAt: m1.sentAt });
  });

  it('inserts a separator at each day boundary, labelled by the newer day', () => {
    // Inverted-list convention: separator labels the messages directly
    // below it (visually) = the messages that came AFTER (newer) the
    // separator's data-array position. With messages newest-first, the
    // separator pushed right after a message gets that message's day —
    // because that message sits visually-below the separator.
    const today1 = msg('t1', localDate(2026, 5, 19, 9, 0));
    const today2 = msg('t2', localDate(2026, 5, 19, 14, 0));
    const yesterday1 = msg('y1', localDate(2026, 5, 18, 10, 0));
    // Newest-first input.
    const feed = withDateSeparators([today2, today1, yesterday1]);
    // Expected: today2, today1, [Today], yesterday1, [Yesterday]
    expect(feed.map((f) => ('kind' in f && f.kind === 'date-separator' ? f.id : f.id))).toEqual([
      't2',
      't1',
      'sep-t1',
      'y1',
      'sep-y1',
    ]);
    expect((feed[2] as { sentAt: number }).sentAt).toBe(today1.sentAt);
    expect((feed[4] as { sentAt: number }).sentAt).toBe(yesterday1.sentAt);
  });

  it('preserves message order — only separators are inserted', () => {
    const a = msg('a', localDate(2026, 5, 19, 8, 0));
    const b = msg('b', localDate(2026, 5, 19, 9, 0));
    const c = msg('c', localDate(2026, 5, 18, 8, 0));
    const feed = withDateSeparators([b, a, c]);
    const onlyMessages = feed.filter((f) => f.kind !== 'date-separator');
    expect(onlyMessages.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });
});
