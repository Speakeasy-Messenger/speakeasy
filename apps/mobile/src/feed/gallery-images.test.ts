import { describe, expect, it } from 'vitest';
import type { Attachment } from '@speakeasy/shared';
import type { ChatMessage } from '../store/conversations.js';
import { collectGalleryImages } from './gallery-images.js';

function att(kind: Attachment['kind'], data: string): Attachment {
  return { kind, mime: kind === 'gif' ? 'image/gif' : 'image/jpeg', data };
}

function msg(id: string, sentAt: number, attachments?: Attachment[]): ChatMessage {
  return { id, from: 'fox', text: '', kind: 'direct', sentAt, stage: 'sent', attachments };
}

describe('collectGalleryImages', () => {
  it('returns [] when there are no messages', () => {
    expect(collectGalleryImages([])).toEqual([]);
  });

  it('returns [] when no message has attachments', () => {
    expect(collectGalleryImages([msg('a', 1), msg('b', 2)])).toEqual([]);
  });

  it('keeps image and gif attachments but drops files', () => {
    const img = att('image', 'IMG');
    const gif = att('gif', 'GIF');
    const file = att('file', 'FILE');
    const out = collectGalleryImages([msg('a', 1, [img, file, gif])]);
    expect(out).toEqual([img, gif]);
  });

  it('flattens across messages in chat (chronological) order', () => {
    const i1 = att('image', '1');
    const i2 = att('image', '2');
    const i3 = att('image', '3');
    // messages are oldest-first in the store; the gallery should mirror that.
    const out = collectGalleryImages([
      msg('a', 1, [i1]),
      msg('b', 2),
      msg('c', 3, [i2, i3]),
    ]);
    expect(out).toEqual([i1, i2, i3]);
  });

  it('preserves attachment identity so indexOf locates the tapped image', () => {
    const tapped = att('image', 'X');
    const out = collectGalleryImages([
      msg('a', 1, [att('image', 'before')]),
      msg('b', 2, [tapped]),
    ]);
    expect(out.indexOf(tapped)).toBe(1);
  });
});
