import type { PushDeliveryNotice, PushProvider } from './push.js';

/**
 * Test fixture — captures every notify call so assertions can verify
 * push fires when (and only when) we expect.
 */
export class MockPushProvider implements PushProvider {
  readonly calls: PushDeliveryNotice[] = [];

  async notifyDelivery(notice: PushDeliveryNotice): Promise<void> {
    this.calls.push(notice);
  }
}
