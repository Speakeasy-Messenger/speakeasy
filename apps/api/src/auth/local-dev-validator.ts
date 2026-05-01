import {
  Validator,
  type Confidence,
  type ValidatedAttestation,
} from '@speakeasy/vouchflow';

/**
 * Stateful `Validator` for sandbox / dev mode.
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
 * Bindings are persisted to `LOCAL_DEV_BINDINGS_FILE` (if set) so they
 * survive server restarts in sandbox mode.
 *
 * **Sandbox / dev only.** Production must use {@link VouchflowValidator}
 * against the real Vouchflow API.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export class LocalDevValidator implements Validator {
  private readonly bindings = new Map<string, string>();
  private readonly persistPath?: string;

  constructor() {
    this.persistPath = process.env.LOCAL_DEV_BINDINGS_FILE || '.dev-bindings.json';
    if (this.persistPath) {
      try {
        const raw = readFileSync(this.persistPath, 'utf-8');
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) {
          this.bindings.set(k, v);
        }
      } catch {
        /* file doesn't exist yet — that's fine */
      }
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.bindings) obj[k] = v;
      writeFileSync(this.persistPath, JSON.stringify(obj));
    } catch {
      /* best effort */
    }
  }

  /** Called by the enroll route after a successful mint. */
  bind(deviceToken: string, userId: string): void {
    this.bindings.set(deviceToken, userId);
    this.save();
  }

  async validate(deviceToken: string): Promise<ValidatedAttestation> {
    if (!deviceToken || typeof deviceToken !== 'string') {
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
