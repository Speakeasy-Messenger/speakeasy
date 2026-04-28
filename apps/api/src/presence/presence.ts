/**
 * Cross-instance presence + session routing per spec §8.
 *
 * Redis keys (production impl):
 *   session:{user_id}  → server instance id (which box owns the live ws)
 *   presence:{user_id} → "online" | "offline:<unix_ms>"
 *
 * Tied to a WebSocket session: recordOnline on auth, recordOffline on close.
 */
export type PresenceState =
  | { state: 'online' }
  | { state: 'offline'; lastSeenMs: number }
  | { state: 'unknown' };

export interface Presence {
  recordOnline(userId: string, instanceId: string): Promise<void>;
  recordOffline(userId: string): Promise<void>;
  /** Server instance id holding the live ws, or undefined if user is not connected. */
  lookupInstance(userId: string): Promise<string | undefined>;
  lookupPresence(userId: string): Promise<PresenceState>;
}
