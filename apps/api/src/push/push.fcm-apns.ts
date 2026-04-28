import type { PushDeliveryNotice, PushProvider } from './push.js';

/**
 * Production placeholder. Real impl wraps `firebase-admin` (FCM) and
 * `@parse/node-apn` (APNs), routes to the appropriate one based on the
 * device's platform, and lands when:
 *   - mobile native shells exist and register push tokens with Vouchflow
 *   - a `devices` row exists per user (Phase 4 multi-device)
 *
 * Throws loudly until then so misconfigured prod builds fail fast.
 */
export class FcmApnsPushProvider implements PushProvider {
  async notifyDelivery(_notice: PushDeliveryNotice): Promise<void> {
    throw new Error(
      'FcmApnsPushProvider: not yet wired (Phase 4 carry-over — needs FCM/APNs creds + device push tokens)',
    );
  }
}
