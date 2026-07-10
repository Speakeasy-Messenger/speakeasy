/**
 * Vouchflow validation codes that mean the auth *infrastructure* failed
 * transiently — the server couldn't reach or get a usable answer from Vouchflow
 * — as opposed to the device's token/attestation being genuinely rejected.
 *
 * These must NOT drive a re-attestation. A fresh passkey prompt can't fix a
 * Vouchflow outage, and if the same outage also blocks the device's own
 * attestation, the verify sheet loops forever (the 2026-07-10 `api.vouchflow.dev`
 * cert-expiry → Cloudflare 525 incident: every auth returned `network_error`,
 * every re-attest hit 525, and the "Verify this device" sheet re-summoned on
 * every reconnect). Treat these as transient: keep the cached token and let the
 * WS reconnect with backoff until the dependency recovers.
 *
 *   network_error — Vouchflow unreachable, or a 5xx/525 from it (the fetch threw
 *                   or returned a non-4xx status). See packages/vouchflow
 *                   api-client.ts.
 *   rate_limited  — 429. Backing off is the fix; hammering with re-attests is not.
 */
export const TRANSIENT_AUTH_FAILURE_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'rate_limited',
]);

/** True when an auth failure code is a transient infra failure, not a genuine
 *  token/attestation rejection. Undefined/unknown codes are treated as genuine
 *  (fail closed toward the existing re-attest behaviour). */
export function isTransientAuthFailure(code: string | undefined | null): boolean {
  return code != null && TRANSIENT_AUTH_FAILURE_CODES.has(code);
}
