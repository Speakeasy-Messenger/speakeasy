/**
 * Disappearing-message TTL timing helpers, shared by the ChatScreen and
 * GroupChatScreen local TTL engines.
 *
 * These are split out (and unit-tested) because the engine arms `setTimeout`
 * for every visible message, and an over-range delay is a *data-loss* bug, not
 * a cosmetic one: when the delay exceeds the signed-32-bit limit it wraps
 * negative under Hermes (and browsers), so `setTimeout` fires on the next tick
 * instead of in the future. The dissolve cascade then ends in `remove()`,
 * which persists the now-empty conversation — i.e. the whole chat's history is
 * wiped ~1.6s after it is opened. A 'month' TTL (2_592_000_000 ms) is over the
 * limit, which is the iOS "1:1 history vanishes right after I leave the chat"
 * report. Clamping the delay below INT32_MAX is the fix.
 */

/** Largest signed-32-bit `setTimeout` delay. Delays above this wrap negative. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The dissolve cascade schedules `disappearing → almost-gone → gone → remove`
 *  at `dissolveAt + {0, 600, 1200, 1600}`. The last tail (`+1600`) must also
 *  stay within INT32, so the base is capped that much lower. */
export const DISSOLVE_TAIL_MS = 1600;

/**
 * When (ms from now) a message should START dissolving, given its TTL and how
 * long ago it was sent.
 *
 * - Lower bound 0: a message already past its TTL dissolves immediately on
 *   open — correct disappearing-message behavior (the message is expired).
 * - Upper bound `MAX_TIMEOUT_MS - DISSOLVE_TAIL_MS`: keeps the whole cascade
 *   (incl. the `+1600` remove tail) within INT32 so it never wraps negative
 *   and insta-purges. The engine re-runs on every screen mount, so a long
 *   ('month') TTL is re-evaluated against fresh `elapsedMs` each time the chat
 *   is opened — the cap only bites if a single chat is held open continuously
 *   for ~24.8 days, which never happens in practice.
 */
export function dissolveDelayMs(ttlMs: number, elapsedMs: number): number {
  return Math.min(Math.max(ttlMs - elapsedMs, 0), MAX_TIMEOUT_MS - DISSOLVE_TAIL_MS);
}

/**
 * The wall-clock anchor (ms) a message's TTL counts from: when THIS device
 * first saw it (`receivedAt`), falling back to send time for messages
 * persisted before `receivedAt` existed.
 *
 * Must be used by BOTH the live TTL engine (ChatScreen/GroupChatScreen) and
 * the cold-start `hydrate()` filter, or they disagree: anchoring `hydrate` on
 * `sentAt` dropped messages that were *received* recently but *sent* long ago
 * (the server buffers messages while a recipient is offline, then relays them
 * with their original old `sentAt` — routine on iOS, which tears the WS down
 * on every background). Such a message would render on arrival, then silently
 * vanish on the next launch. Anchoring on `receivedAt` gives every message a
 * full TTL from the moment it lands on the device — i.e. "messages leave in
 * <ttl> after they arrive," which is what the user sees.
 */
export function ttlAnchorMs(m: { sentAt: number; receivedAt?: number }): number {
  return m.receivedAt ?? m.sentAt;
}
