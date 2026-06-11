import type { Attachment } from '@speakeasy/shared';

/**
 * Whether a message's attachments should render edge-to-edge (the bubble
 * drops its text padding so a bitmap fills it corner-to-corner). True
 * ONLY for a caption-less set of images/gifs.
 *
 * Files are explicitly excluded: a FileCard is a bordered name+size card,
 * not a bitmap. Zeroing the bubble padding around it — plus the card
 * supplying no intrinsic width — collapsed the bubble onto the card
 * border and squeezed the (numberOfLines=1) filename to nothing (reported
 * bug: "filename cut off / message box malformed"). A file keeps the
 * normal bubble padding; its own fixed-width card carries the layout.
 *
 * Pure (no react-native imports) so it's unit-testable without an RN
 * runtime — see AttachmentView.test.ts.
 */
export function isEdgeToEdgeMedia(
  attachments: Attachment[] | undefined,
  hasText: boolean,
): boolean {
  return (
    !!attachments &&
    attachments.length > 0 &&
    !hasText &&
    attachments.every((a) => a.kind === 'image' || a.kind === 'gif')
  );
}
