import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const verify = vi.fn(async () => ({ deviceToken: 'dvt_test' }));
  return { instance: undefined as unknown, verify };
});

vi.mock('./vouchflow.js', () => ({
  NativeVouchflowClient: class {
    constructor() {
      native.instance = this;
    }

    verify() {
      return native.verify();
    }

    requestFallback = vi.fn();
    submitFallbackOtp = vi.fn();
    getCachedDeviceToken = vi.fn();
  },
}));

vi.mock('@speakeasy/crypto', () => ({
  NativeGroupMessagingModule: class {},
  NativeSignalProtocolModule: class {},
}));

vi.mock('../api/client.js', () => ({
  ApiClient: class {},
}));

vi.mock('../config.js', () => ({
  config: { apiBaseUrl: 'https://api.test', wsUrl: 'wss://ws.test' },
}));

vi.mock('../ws/client.js', () => ({
  SpeakeasyWsClient: class {},
}));

vi.mock('../store/connection.js', () => ({
  useConnection: { getState: () => ({ setState: vi.fn() }) },
}));

vi.mock('../diag/log.js', () => ({ diag: vi.fn() }));

vi.mock('../push/push-notifications.js', () => ({
  NativePushNotificationService: class {},
}));

import { vouchflow } from '../services.js';

describe('Vouchflow client wiring', () => {
  beforeEach(() => {
    native.verify.mockClear();
  });

  it('exports the native client instance without an interposed layer', () => {
    expect(vouchflow).toBe(native.instance);
  });

  it('delegates every verification to the native SDK', async () => {
    await vouchflow.verify({ context: 'login', minimumConfidence: 'low' });
    await vouchflow.verify({ context: 'login', minimumConfidence: 'low' });

    expect(native.verify).toHaveBeenCalledTimes(2);
  });
});
