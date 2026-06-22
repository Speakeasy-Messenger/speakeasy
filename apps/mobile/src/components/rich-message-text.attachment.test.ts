/**
 * Guards the long-text → attachment conversion used by both chat
 * composers. Over-length text (> SEND_TEXT_MAX_CHARS) is no longer
 * dropped as `too_long`; it's converted to a text/plain `message.txt`
 * file attachment so it rides the large-payload attachment path.
 */
import { describe, expect, it } from 'vitest';
import {
  SEND_TEXT_MAX_CHARS,
  longTextToAttachment,
} from './rich-message-text.js';
import { b64ToBytes, utf8FromBytes } from '../utils/bytes.js';

describe('longTextToAttachment', () => {
  it('produces a text/plain file attachment named message.txt', () => {
    const text = 'x'.repeat(SEND_TEXT_MAX_CHARS + 1);
    const att = longTextToAttachment(text);
    expect(att.kind).toBe('file');
    expect(att.mime).toBe('text/plain');
    expect(att.name).toBe('message.txt');
    expect(typeof att.data).toBe('string');
    expect(att.data.length).toBeGreaterThan(0);
  });

  it('round-trips the original text through base64 utf-8', () => {
    const text = 'hello 😀 ' + 'long '.repeat(5000);
    const att = longTextToAttachment(text);
    expect(utf8FromBytes(b64ToBytes(att.data))).toBe(text);
  });
});
