import { describe, expect, it } from 'vitest';
import {
  parseMentions,
  encodePayload,
  decodePayload,
  replyPreviewFrom,
  REPLY_PREVIEW_MAX,
} from './index.js';

describe('parseMentions', () => {
  it('extracts a single @mention', () => {
    expect(parseMentions('hey @alice check this')).toEqual(['alice']);
  });

  it('extracts multiple different @mentions', () => {
    const result = parseMentions('@bob @carol_99 @bob');
    expect(result.sort()).toEqual(['bob', 'carol_99']);
  });

  it('ignores @ at start of another word (no space before)', () => {
    expect(parseMentions('email@example.com')).toEqual([]);
  });

  it('handles @ at start of line', () => {
    expect(parseMentions('@alice hello')).toEqual(['alice']);
  });

  it('skips handles starting with digits', () => {
    expect(parseMentions('@1abc')).toEqual([]);
  });

  it('respects max handle length of 20 chars', () => {
    // 21-char handle: a + 20 more = too long for [a-z][a-z0-9_]{1,19}
    expect(parseMentions('@abcdefghijklmnopqrstu')).toEqual([]);
  });

  it('accepts exactly 20-char handle', () => {
    // a + 19 more = 20 total — within [a-z][a-z0-9_]{1,19}
    expect(parseMentions('@abcdefghijklmnopqrst')).toEqual(['abcdefghijklmnopqrst']);
  });

  it('returns empty for text with no @', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
  });
});

describe('MessagePayload mentions round-trip', () => {
  it('survives encode → decode', () => {
    const payload = { v: 1 as const, text: '@alice check @bob', mentions: ['alice', 'bob'] };
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded.mentions).toEqual(['alice', 'bob']);
  });

  it('handles payload with no mentions (backward compat)', () => {
    const payload = { v: 1 as const, text: 'hello' };
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded.mentions).toBeUndefined();
  });
});

describe('MessagePayload replyTo (quote-reply) round-trip', () => {
  const reply = { id: 'msg-001', from: 'alice', preview: 'see you at 5' };

  it('survives encode → decode', () => {
    const decoded = decodePayload(
      encodePayload({ v: 1, text: 'ok!', replyTo: reply }),
    );
    expect(decoded.replyTo).toEqual(reply);
    expect(decoded.text).toBe('ok!');
  });

  it('a normal message decodes with no replyTo (back-compat)', () => {
    const decoded = decodePayload(encodePayload({ v: 1, text: 'hi' }));
    expect(decoded.replyTo).toBeUndefined();
  });

  it('a legacy raw-text message has no replyTo', () => {
    expect(decodePayload('plain old text').replyTo).toBeUndefined();
  });

  it('drops a malformed replyTo (missing fields) defensively', () => {
    // A hostile / buggy peer sends replyTo without `preview`.
    const wire = JSON.stringify({ v: 1, text: 'x', replyTo: { id: 'm', from: 'a' } });
    expect(decodePayload(wire).replyTo).toBeUndefined();
  });

  it('drops a non-object replyTo', () => {
    const wire = JSON.stringify({ v: 1, text: 'x', replyTo: 'nope' });
    expect(decodePayload(wire).replyTo).toBeUndefined();
  });
});

describe('replyPreviewFrom', () => {
  it('uses the text when present', () => {
    expect(replyPreviewFrom({ text: 'hello there' })).toBe('hello there');
  });

  it('falls back to a media noun for attachment-only messages', () => {
    expect(
      replyPreviewFrom({ attachments: [{ kind: 'image', mime: 'image/jpeg', data: '' }] }),
    ).toBe('image');
    expect(
      replyPreviewFrom({ attachments: [{ kind: 'gif', mime: 'image/gif', data: '' }] }),
    ).toBe('GIF');
  });

  it('clamps an over-long preview to the cap with an ellipsis', () => {
    const long = 'x'.repeat(REPLY_PREVIEW_MAX + 50);
    const preview = replyPreviewFrom({ text: long });
    expect(preview.length).toBe(REPLY_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('is empty for an empty message', () => {
    expect(replyPreviewFrom({})).toBe('');
  });
});
