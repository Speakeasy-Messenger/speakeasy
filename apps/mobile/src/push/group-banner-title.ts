/**
 * Resolve a GROUP notification's banner top (the conversation title). It
 * must identify the ROOM, never one member — otherwise it duplicates the
 * per-line sender shown inside MessagingStyle ("@chloro" appearing as both
 * the title and the message author, chloro 2026-06-04).
 *
 * A member handle leaks in two ways: a local group name that's literally
 * the sender handle (an unnamed room the store only ever learned from a
 * message, never via `Room with @…` metadata), or a stale / mis-resolved
 * server title. Reject ANY candidate equal to the sender handle (with or
 * without the `@`), then prefer the locally-known room name, the server
 * room name, and finally a neutral label.
 *
 * Kept in its own dependency-free module so it's unit-testable without
 * pulling the native-heavy push-handler into the test runner.
 */
export function resolveGroupBannerTitle(
  localName: string | undefined,
  serverTitle: string | undefined,
  peerHandle: string,
): string {
  const handleForms = new Set([peerHandle, '@' + peerHandle]);
  const roomName = (s: string | undefined): string | undefined =>
    s && !handleForms.has(s) ? s : undefined;
  return roomName(localName) || roomName(serverTitle) || 'speakeasy';
}
