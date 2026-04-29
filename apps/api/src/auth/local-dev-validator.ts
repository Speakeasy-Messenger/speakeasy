import {
  Validator,
  type Confidence,
  type ValidatedAttestation,
} from '@speakeasy/vouchflow';

/**
 * Stateful in-memory `Validator` for sandbox / dev mode.
 *
 * Real Vouchflow tracks the (deviceToken → userId) binding inside its
 * own backend, so subsequent verifies after enrollment return the
 * already-bound userId. The {@link MockValidator.alwaysSucceeds} factory
 * returns a stateless mock with no userId, which means WS auth would
 * always think it's a fresh device — fine for unit tests, broken for
 * an end-to-end demo APK.
 *
 * This class fills the gap. It returns `userId: undefined` on the first
 * call for a token (so the enroll route mints a fresh id), then holds
 * the binding so every subsequent call (login, WS auth) returns the
 * same `userId`. The binding is written by `bind()` — the enroll route
 * calls it after the user-repo mint succeeds.
 *
 * **Sandbox / dev only.** Production must use {@link VouchflowValidator}
 * against the real Vouchflow API. There's no persistence here — process
 * restart drops every binding, every device must re-enroll.
 */
export class LocalDevValidator implements Validator {
  private readonly bindings = new Map<string, string>();

  /** Called by the enroll route after a successful mint. */
  bind(deviceToken: string, userId: string): void {
    this.bindings.set(deviceToken, userId);
  }

  async validate(deviceToken: string): Promise<ValidatedAttestation> {
    if (!deviceToken || typeof deviceToken !== 'string') {
      // The MockValidator pattern is to throw on bad input. We return a
      // structured failure instead so the route handler can map cleanly.
      throw new Error(`LocalDevValidator: empty deviceToken`);
    }
    const userId = this.bindings.get(deviceToken);
    return {
      token: deviceToken,
      deviceToken,
      userId,
      confidence: 'low' as Confidence,
      verifiedAt: new Date().toISOString(),
      riskScore: 0,
      anomalyFlags: [],
      lastContext: 'login',
      biometricUsed: false,
      fallbackUsed: false,
      platform: 'android',
    };
  }
}
