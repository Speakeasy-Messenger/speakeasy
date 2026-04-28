import { describe, expect, it } from 'vitest';
import { MockVouchflowClient } from './mock-vouchflow.js';
import { NativeVouchflowClient, VouchflowClientError } from './vouchflow.js';

describe('MockVouchflowClient', () => {
  it('verify() returns a deviceToken and confidence the server can validate', async () => {
    const c = new MockVouchflowClient({ deviceToken: 'dvt_demo', confidence: 'high' });
    const r = await c.verify({ context: 'signup' });
    expect(r.verified).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.deviceToken).toBe('dvt_demo');
    expect(r.signals.biometricUsed).toBe(true);
    expect(r.signals.persistentToken).toBe(true);
  });

  it('verify() respects minimumConfidence option being passed through', async () => {
    const c = new MockVouchflowClient({ confidence: 'medium' });
    const r = await c.verify({ context: 'sensitive_action', minimumConfidence: 'medium' });
    expect(r.confidence).toBe('medium');
  });

  it('throws when configured to', async () => {
    const c = new MockVouchflowClient({ throwOnVerify: new Error('biometric_cancelled') });
    await expect(c.verify({ context: 'login' })).rejects.toThrow(/biometric_cancelled/);
  });
});

describe('NativeVouchflowClient', () => {
  it('throws when react-native is unavailable (test env)', () => {
    // In Node test env the require('react-native') fails, so the constructor
    // throws a structured VouchflowClientError. On a real device with the
    // Phase 5b APK the module is registered and verify() works.
    expect(() => new NativeVouchflowClient()).toThrow(VouchflowClientError);
    try {
      new NativeVouchflowClient();
    } catch (e) {
      expect((e as VouchflowClientError).reason).toBe('unknown_error');
    }
  });
});
