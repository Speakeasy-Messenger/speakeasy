/**
 * Emoji handling in message text — guards that emojis survive the rich-
 * text pipeline. RN/Hermes encode UTF-8 and render color emoji natively,
 * so the only real hazard is the "See more" truncation splitting an
 * emoji's surrogate pair at the 600-char boundary (→ the � glyph). See
 * `truncateForPreview`.
 */
import { describe, expect, it } from 'vitest';
import { tokenize, truncateForPreview } from './rich-message-text.js';

const GRINNING = '\u{1F600}'; // 😀 — a surrogate pair (2 UTF-16 code units)

describe('emoji in tokenize()', () => {
  it('keeps a plain emoji message as one intact plain segment', () => {
    const text = `great job ${GRINNING}\u{1F389}`; // 😀🎉
    expect(tokenize(text, false)).toEqual([{ kind: 'plain', text }]);
  });

  it('preserves emoji adjacent to a link and a mention', () => {
    const text = `${GRINNING} see http://x.com then ping @bob ${GRINNING}`;
    const segs = tokenize(text, true);
    // Every plain segment + the rejoined whole still contains both emoji,
    // and no segment text is corrupted with a lone surrogate.
    const rejoined = segs.map((s) => s.text).join('');
    expect(rejoined).toContain(GRINNING);
    expect(segs.some((s) => s.kind === 'mention' && s.text === '@bob')).toBe(true);
    expect(segs.some((s) => s.kind === 'link')).toBe(true);
    for (const s of segs) expect(hasLoneSurrogate(s.text)).toBe(false);
  });
});

describe('truncateForPreview()', () => {
  const head = 'a'.repeat(10);
  const tail = 'b'.repeat(10);
  const text = head + GRINNING + tail; // emoji occupies UTF-16 indices 10,11

  it('returns the text unchanged when within the limit', () => {
    expect(truncateForPreview('hi \u{1F44D}', 600)).toBe('hi \u{1F44D}');
  });

  it('a naive slice WOULD split the emoji (documents the bug)', () => {
    const naive = text.slice(0, 11); // cuts between the surrogate pair
    expect(hasLoneSurrogate(naive)).toBe(true);
  });

  it('drops the straddling emoji cleanly instead of leaving half', () => {
    const out = truncateForPreview(text, 11);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe(head); // emoji dropped, no � left behind
  });

  it('keeps a full emoji when the boundary falls just past it', () => {
    const out = truncateForPreview(text, 12);
    expect(out).toContain(GRINNING);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

/** True if the string contains an unpaired UTF-16 surrogate (the � cause). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // high without low
      i++; // valid pair — skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low without preceding high
    }
  }
  return false;
}
