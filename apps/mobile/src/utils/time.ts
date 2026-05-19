/**
 * Date / time formatting helpers for the chat feed.
 *
 * Two surfaces use these:
 *  - Each message bubble renders the time it was sent ("3:04 PM").
 *  - A separator row sits above the first message of each day with a
 *    relative label ("Today" / "Yesterday" / weekday / full date).
 *
 * All formatting is locale-aware via `Intl.DateTimeFormat`, which
 * Hermes ships on modern RN. The `now` parameter is injected so unit
 * tests can pin a deterministic reference time.
 */

/** True if `a` and `b` fall on the same local-time calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "3:04 PM" / "15:04" — locale-decided. */
export function formatMessageTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

/**
 * Relative day label for a feed separator. Anchored to `now` so the
 * label is stable for any given session.
 *
 *   - same local day as `now`        → "Today"
 *   - the local day before `now`     → "Yesterday"
 *   - within the prior six days      → weekday name (e.g. "Wednesday")
 *   - older, same calendar year      → "Jan 5"
 *   - older, different year          → "Jan 5, 2024"
 */
export function formatDateSeparator(ms: number, now: number = Date.now()): string {
  if (isSameLocalDay(ms, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDay(ms, yesterday.getTime())) return 'Yesterday';

  // Within the last 7 days (excluding today / yesterday handled above):
  // use the weekday name. Anchor to local-midnight of `now` so DST
  // transitions don't flip a borderline message into the wrong bucket.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const sixDaysAgo = startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000;
  if (ms >= sixDaysAgo) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(ms));
  }

  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(ms));
}
