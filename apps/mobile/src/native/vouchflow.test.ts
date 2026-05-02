import { describe, expect, it } from 'vitest';
import { NativeVouchflowClient, VouchflowClientError } from './vouchflow.js';

describe('NativeVouchflowClient', () => {
  it('throws when react-native is unavailable (test env)', () => {
    // In Node test env the require('react-native') fails, so the constructor
    // throws a structured VouchflowClientError. On a real device with the
    // SDK 2.0.0 APK the module is registered and verify() works.
    expect(() => new NativeVouchflowClient()).toThrow(VouchflowClientError);
    try {
      new NativeVouchflowClient();
    } catch (e) {
      expect((e as VouchflowClientError).reason).toBe('unknown_error');
    }
  });
});
