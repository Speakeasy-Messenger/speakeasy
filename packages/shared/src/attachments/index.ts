/**
 * Encrypted-message payload schema. The wire frame still carries a
 * single ciphertext blob; that ciphertext is now the encrypted form
 * of `JSON.stringify(MessagePayload)` instead of raw utf-8 text.
 *
 * Backwards compat: a peer running pre-v1 code emits raw utf-8 (no
 * JSON envelope). The receiver's `decodePayload` checks the first
 * byte for `{` and falls back to `{v: 1, text: <raw>}` otherwise, so
 * old clients keep rendering correctly.
 *
 * Size budget per the alpha-0.4.16 plan:
 *   - photo / image: ≤ 800KB raw, picker resizes to ≤1024px JPEG q0.7
 *   - gif:           ≤ 1MB raw (no resize — would break animation)
 *   - file:          ≤ 800KB raw
 *
 * Multi-photo "albums" pack into the `attachments` array on a single
 * message — the chat renderer groups them visually (2x2 grid etc.).
 */

export type AttachmentKind = 'image' | 'gif' | 'file';

export interface Attachment {
  kind: AttachmentKind;
  /** MIME, e.g. `image/jpeg`, `image/gif`, `application/pdf`. */
  mime: string;
  /** Base64-encoded bytes. */
  data: string;
  /** Display name for files (the picker's source filename). Optional
   * for images — they're shown inline. */
  name?: string;
}

/** Human noun for an attachment kind — for list previews + notifications. */
export function attachmentNoun(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image';
    case 'gif':
      return 'GIF';
    case 'file':
      return 'file';
  }
}

/**
 * One-line preview for a message: its text if present, else a noun for its
 * first attachment ("image" / "GIF" / "file"), else ''. Keeps an
 * attachment-only message from rendering blank in the conversation list and
 * (where the content is available) in notifications.
 */
export function messagePreviewText(m: {
  text?: string;
  attachments?: Attachment[];
}): string {
  const t = m.text?.trim();
  if (t) return t;
  const first = m.attachments?.[0];
  return first ? attachmentNoun(first.kind) : '';
}

export interface MessagePayload {
  /** Schema version. Bump on breaking changes. */
  v: 1;
  /** Optional caption / standalone text body. */
  text?: string;
  /** Up to N attachments per message (UI groups them). */
  attachments?: Attachment[];
  /**
   * User handles that were @mentioned in this message.
   * Each entry is a bare handle (no `@` prefix). The renderer
   * highlights them; the server may use them for selective push.
   */
  mentions?: string[];
}

/** Pack a payload into the utf-8 plaintext that gets handed to the
 * Signal Protocol encrypt path. */
export function encodePayload(p: MessagePayload): string {
  return JSON.stringify(p);
}

/** Decode the plaintext that came out of Signal decrypt. Tolerant of
 * pre-v1 raw-text messages — those round-trip as a `{v:1, text: …}`
 * payload so the renderer can treat them uniformly. */
export function decodePayload(plain: string): MessagePayload {
  // Quick sniff — proper JSON envelopes always start with `{`.
  // Anything else is legacy plain-text content.
  const trimmed = plain.trimStart();
  if (!trimmed.startsWith('{')) {
    return { v: 1, text: plain };
  }
  try {
    const parsed = JSON.parse(plain) as Partial<MessagePayload>;
    if (parsed && parsed.v === 1) {
      return {
        v: 1,
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments.filter((a): a is Attachment =>
              !!a && (a.kind === 'image' || a.kind === 'gif' || a.kind === 'file')
                && typeof a.mime === 'string'
                && typeof a.data === 'string',
            )
          : undefined,
        mentions: Array.isArray(parsed.mentions)
          ? parsed.mentions.filter((m): m is string => typeof m === 'string')
          : undefined,
      };
    }
    // Unknown / future version → fall back to raw text.
    return { v: 1, text: plain };
  } catch {
    return { v: 1, text: plain };
  }
}

/**
 * Extract @mentions from text.
 * Matches `@` followed by valid handle characters `[a-z][a-z0-9_]{1,19}`.
 * Returns deduplicated set of bare handles (no `@` prefix).
 */
export function parseMentions(text: string): string[] {
  const re = /(^|\s)@([a-z][a-z0-9_]{1,19})(?=[^a-z0-9_]|$)/gi;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    seen.add(match[2]!);
  }
  return Array.from(seen);
}
