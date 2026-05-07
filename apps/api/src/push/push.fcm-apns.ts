// firebase-admin ships as a CJS module with a single default export; the
// `import * as` namespace shape only exposes `.default` under Node's
// ESM interop. Use the default-import form so `admin.credential.cert`
// resolves at the top level. (Crash repro: alpha-0.4.30 startup —
// `Cannot read properties of undefined (reading 'cert')`.)
import admin from 'firebase-admin';
import type { PushDeliveryNotice, PushProvider } from './push.js';
import type { DevicesRepo } from '../db/devices.js';

/**
 * Production push provider — FCM (Android) + APNs (iOS).
 *
 * Notify-only per spec §11: payloads carry no message content. Just a
 * data-only FCM message so the device wakes and drains buffered messages
 * via the WS reconnect path.
 */
export class FcmApnsPushProvider implements PushProvider {
  private app: admin.app.App;

  constructor(
    private readonly devices: DevicesRepo,
    opts?: { credential?: admin.ServiceAccount },
  ) {
    this.app = admin.initializeApp(
      {
        credential: admin.credential.cert(
          opts?.credential ?? {
            projectId: process.env.FCM_PROJECT_ID,
            clientEmail: process.env.FCM_CLIENT_EMAIL,
            privateKey: process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          },
        ),
      },
      'speakeasy-push',
    );
  }

  async notifyDelivery(notice: PushDeliveryNotice): Promise<void> {
    const userDevices = await this.devices.listForUser(notice.userId);
    const withPush = userDevices.filter((d) => d.pushToken);
    if (withPush.length === 0) return;

    // Spec §11/§12: notify-only, no content. The `notification` payload
    // is a generic "you have a new message" — system-level FCM uses it
    // to auto-display a banner when the app is backgrounded, without
    // leaking sender, conversation, or text. The `data` block still
    // rides along so the foregrounded app can route via the WS reconnect
    // path. iOS APNs honours the same shape via the firebase-admin SDK
    // (the SDK transparently maps to the APNs `aps.alert` field).
    const payload: admin.messaging.MulticastMessage = {
      notification: {
        title: 'speakeasy',
        body: 'New message',
      },
      data: {
        conversation_id: notice.conversationId,
        msg_type: notice.msgType,
      },
      tokens: withPush.map((d) => d.pushToken!),
    };

    const response = await admin.messaging(this.app).sendEachForMulticast(payload);
    if (response.failureCount > 0) {
      // Log failures but don't throw — one bad token shouldn't block others.
      const failed = response.responses.filter((r) => !r.success);
      // eslint-disable-next-line no-console
      console.warn(
        { failures: failed.map((f) => f.error?.message) },
        'FCM push: some deliveries failed',
      );
    }
  }
}
