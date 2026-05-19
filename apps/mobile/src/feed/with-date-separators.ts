import type { ChatMessage } from '../store/conversations.js';
import { isSameLocalDay } from '../utils/time.js';

/**
 * Date-separator row injected into the chat feed by [withDateSeparators].
 * `kind: 'date-separator'` is the discriminator that the FlatList
 * `renderItem` switches on — `ChatMessage.kind` is `'direct' | 'group'`,
 * so the two types don't collide.
 */
export interface DateSeparatorItem {
  kind: 'date-separator';
  id: string;
  /** Any millisecond on the labelled day — resolved to "Today" / etc. */
  sentAt: number;
}

export type ChatFeedItem = ChatMessage | DateSeparatorItem;

/**
 * Interleave date-change separators into a newest-first message array
 * for an `inverted` FlatList.
 *
 * The inverted list renders `data[0]` at the visual bottom; visually
 * we want each day label to sit ABOVE that day's messages. Walking the
 * array newest-first, a separator is inserted AFTER the *oldest*
 * message of each day so it lands above that day visually:
 *
 *   data[0]  today latest    \
 *   data[1]  today earlier    } visually:  [Wednesday]
 *   data[2]  [Today]                       Wed earlier
 *   data[3]  Wed latest                    Wed latest
 *   data[4]  Wed earlier                   [Today]
 *   data[5]  [Wednesday]                   today earlier
 *                                          today latest
 *
 * The separator's label comes from the message it sits *under* in the
 * data array — the older one — so "Wednesday" sits at the very top
 * above all Wednesday messages.
 *
 * Pure + deterministic, so easy to unit-test. `messages` must be
 * newest-first.
 */
export function withDateSeparators(messages: ChatMessage[]): ChatFeedItem[] {
  if (messages.length === 0) return [];
  const out: ChatFeedItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    const next = messages[i + 1];
    const dayChanges = next ? !isSameLocalDay(m.sentAt, next.sentAt) : true;
    if (dayChanges) {
      // A separator inserted right after `m` in the data array lands
      // (in an inverted list) BETWEEN `m` visually-below and `next`
      // visually-above, so the day it labels is `m`'s day — the one
      // whose messages sit below the separator. Convention: "Today"
      // / "Wednesday" labels the messages directly beneath it.
      out.push({
        kind: 'date-separator',
        id: `sep-${m.id}`,
        sentAt: m.sentAt,
      });
    }
  }
  return out;
}
