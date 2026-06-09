import type { Attachment } from '@speakeasy/shared';
import type { ChatMessage } from '../store/conversations.js';

/**
 * The ordered list of attachments the media viewer can page through for
 * a conversation: every `image`/`gif` attachment across `messages`, in
 * chat order.
 *
 * - `messages` is kept chronological by the conversations store (see
 *   `localOrderKey`), so the returned list is oldest → newest — swiping
 *   right in the viewer moves to a newer picture.
 * - `file` attachments are excluded: they open via `saveAndAnnounceFile`,
 *   not the image viewer, so they must not appear as gallery pages.
 * - Attachment object identity is preserved (no copies), so callers can
 *   locate the tapped attachment with `indexOf`.
 */
export function collectGalleryImages(messages: readonly ChatMessage[]): Attachment[] {
  return messages
    .flatMap((m) => m.attachments ?? [])
    .filter((a) => a.kind === 'image' || a.kind === 'gif');
}
