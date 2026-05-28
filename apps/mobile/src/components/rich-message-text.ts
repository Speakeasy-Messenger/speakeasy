/**
 * Pure text-segmentation logic for RichMessageText.
 *
 * Kept free of any react-native import so it can be unit-tested under
 * Vitest — importing a file that calls `StyleSheet.create` at module
 * load throws in the test environment.
 */

/**
 * Messages longer than this are truncated in the bubble with a
 * "See more" affordance.
 */
export const LONG_MESSAGE_CHARS = 600;

/**
 * Hard cap on outbound message text. Sends above this are stamped as
 * `too_long` failures client-side without ever attempting WS dispatch
 * — long-form text doesn't fit cleanly through the WS frame, FCM push
 * payload, and signal-protocol envelope chain, and the user-visible
 * symptom was a generic "couldn't send · tap to resend" cue that
 * never recovered no matter how many times you tapped.
 *
 * 16k is generous — multi-paragraph notes fit, document-length essays
 * don't. If field feedback says this is wrong (real users hitting it
 * on legitimate sends), drop it; if real users complain that 1000-char
 * messages still mysteriously fail, lower it.
 */
export const SEND_TEXT_MAX_CHARS = 16_000;

// http/https URLs and bare `www.` links. Trailing sentence punctuation
// is trimmed off the match below so "see http://x.com." keeps the period
// as plain text.
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
const MENTION_RE = /(^|\s)(@[a-z][a-z0-9_]{1,19})(?=[^a-z0-9_]|$)/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

export type Segment =
  | { kind: 'plain'; text: string }
  | { kind: 'mention'; text: string }
  | { kind: 'link'; text: string; url: string };

/**
 * Split message text into plain / mention / link segments. Mentions are
 * only matched when `withMentions` is set (the message carried a
 * `mentions` list), mirroring the prior MentionText behaviour. Links are
 * always matched. Overlapping matches keep the earlier one.
 */
export function tokenize(text: string, withMentions: boolean): Segment[] {
  interface Hit {
    start: number;
    end: number;
    seg: Segment;
  }
  const hits: Hit[] = [];

  const ure = new RegExp(URL_RE.source, URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = ure.exec(text)) !== null) {
    let matched = m[0];
    const trail = matched.match(TRAILING_PUNCT_RE);
    if (trail) matched = matched.slice(0, -trail[0].length);
    if (!matched) continue;
    const url = matched.startsWith('www.') ? `https://${matched}` : matched;
    hits.push({
      start: m.index,
      end: m.index + matched.length,
      seg: { kind: 'link', text: matched, url },
    });
  }

  if (withMentions) {
    const mre = new RegExp(MENTION_RE.source, MENTION_RE.flags);
    while ((m = mre.exec(text)) !== null) {
      const handle = m[2]!;
      const start = m.index + (m[1]?.length ?? 0);
      hits.push({
        start,
        end: start + handle.length,
        seg: { kind: 'mention', text: handle },
      });
    }
  }

  hits.sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue; // overlapping match — skip
    if (h.start > cursor) {
      segs.push({ kind: 'plain', text: text.slice(cursor, h.start) });
    }
    segs.push(h.seg);
    cursor = h.end;
  }
  if (cursor < text.length) {
    segs.push({ kind: 'plain', text: text.slice(cursor) });
  }
  return segs;
}
