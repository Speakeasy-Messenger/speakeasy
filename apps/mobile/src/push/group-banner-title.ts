/**
 * Resolve a GROUP notification's banner top (the conversation title). It
 * must identify the ROOM, never one member — otherwise it duplicates the
 * per-line sender shown inside MessagingStyle (the same handle twice).
 *
 * Sources, in order of trust:
 *  1. `localName` — the room name in THIS device's store (what the user
 *     sees in-app). Authoritative when present, but group renames are
 *     currently creator-local (no server sync), so a member who didn't
 *     name the room won't have it.
 *  2. `serverTitle` — the server's room name (the creation name; same for
 *     every member). Covers members who never got the creator's rename.
 *  3. `members` — a derived "Room with @a, @b" label, matching the in-app
 *     fallback for an unnamed room. Better than a generic word when no
 *     real name reached this device.
 *  4. 'speakeasy' — last resort.
 *
 * Any candidate equal to the sender handle (with or without '@') is
 * rejected so the title can never collapse onto the per-line sender.
 *
 * Kept dependency-free so it's unit-testable without the native-heavy
 * push-handler.
 */
export function resolveGroupBannerTitle(
  localName: string | undefined,
  serverTitle: string | undefined,
  peerHandle: string,
  opts?: { members?: string[]; selfId?: string },
): string {
  const handleForms = new Set([peerHandle, '@' + peerHandle]);
  const roomName = (s: string | undefined): string | undefined =>
    s && !handleForms.has(s) ? s : undefined;

  const named = roomName(localName) || roomName(serverTitle);
  if (named) return named;

  // Derived "Room with @…" from the member list (self excluded), capped so
  // the banner stays short. Mirrors GroupChatScreen's unnamed-room label.
  const others = (opts?.members ?? []).filter((m) => m && m !== opts?.selfId);
  if (others.length > 0) {
    return `Room with ${others.slice(0, 3).map((m) => '@' + m).join(', ')}`;
  }
  return 'speakeasy';
}
