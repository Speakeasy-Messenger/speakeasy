import { describe, expect, it } from 'vitest';
import {
  MockPushNotificationService,
  NoopPushNotificationService,
} from './push-notifications.js';

describe('MockPushNotificationService', () => {
  it('returns a default fake token', async () => {
    const svc = new MockPushNotificationService();
    const result = await svc.getToken();
    expect(result).toEqual({ pushToken: 'mock-fcm-token', platform: 'android' });
  });

  it('returns the injected result', async () => {
    const svc = new MockPushNotificationService({
      pushToken: 'custom-token',
      platform: 'ios',
    });
    const result = await svc.getToken();
    expect(result).toEqual({ pushToken: 'custom-token', platform: 'ios' });
  });
});

describe('NoopPushNotificationService', () => {
  it('returns undefined', async () => {
    const svc = new NoopPushNotificationService();
    const result = await svc.getToken();
    expect(result).toBeUndefined();
  });
});
