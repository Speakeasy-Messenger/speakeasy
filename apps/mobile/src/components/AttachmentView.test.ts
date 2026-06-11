import { describe, expect, it } from 'vitest';
import type { Attachment } from '@speakeasy/shared';
import { isEdgeToEdgeMedia } from './attachment-layout.js';

const img = (): Attachment => ({ kind: 'image', mime: 'image/png', data: 'AAAA', name: 'p.png' });
const gif = (): Attachment => ({ kind: 'gif', mime: 'image/gif', data: 'AAAA', name: 'a.gif' });
const file = (): Attachment => ({ kind: 'file', mime: 'application/pdf', data: 'AAAA', name: 'doc.pdf' });

describe('isEdgeToEdgeMedia', () => {
  it('is false with no attachments', () => {
    expect(isEdgeToEdgeMedia(undefined, false)).toBe(false);
    expect(isEdgeToEdgeMedia([], false)).toBe(false);
  });

  it('is true for caption-less images/gifs', () => {
    expect(isEdgeToEdgeMedia([img()], false)).toBe(true);
    expect(isEdgeToEdgeMedia([img(), gif()], false)).toBe(true);
  });

  it('is false when the media has a caption (padding kept for the text)', () => {
    expect(isEdgeToEdgeMedia([img()], true)).toBe(false);
  });

  // The bug guard: a file attachment must NEVER be edge-to-edge. Zeroing the
  // bubble padding around a FileCard collapsed it and cut off the filename.
  it('is false for a file attachment (the cut-off-filename regression)', () => {
    expect(isEdgeToEdgeMedia([file()], false)).toBe(false);
  });

  it('is false for a mixed photo+file set', () => {
    expect(isEdgeToEdgeMedia([img(), file()], false)).toBe(false);
  });
});
