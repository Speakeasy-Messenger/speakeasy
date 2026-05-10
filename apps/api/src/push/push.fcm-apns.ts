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
    if (withPush.length === 0) {
      // Recurring report shape: "@<peer> isn't getting push notifications".
      // Almost always this — the recipient never registered an FCM token
      // (denied permission, Firebase unlinked on dev build, or simply
      // never cold-launched the rc.31+ build that fixed registration).
      // Log it so the next "no notifications" report is one server-log
      // grep away from a diagnosis instead of a multi-turn dig.
      // eslint-disable-next-line no-console
      console.warn(
        {
          userId: notice.userId,
          totalDevices: userDevices.length,
          kind: notice.kind ?? 'message',
        },
        'push notify: no devices with push_token (silently dropped)',
      );
      return;
    }

    // Per-device privacy: a user can have a 'rich' work phone and a
    // 'private' bedside tablet. Group device tokens by the resolved
    // banner copy so every device sees its preferred treatment in
    // one batched FCM call. Sealed senderId is forced to undefined
    // upstream (handler.ts doesn't pass it through) so 'rich' devices
    // still degrade gracefully when the message can't be attributed.
    const kind = notice.kind ?? 'message';
    const data = {
      conversation_id: notice.conversationId,
      msg_type: notice.msgType,
      notify_kind: kind,
    };
    const buckets = new Map<string, { title: string; body: string; tokens: string[] }>();
    for (const d of withPush) {
      const privacy = d.notificationPrivacy ?? 'rich';
      const showSender = privacy === 'rich' && !!notice.senderId;
      // Spec §11/§12: notify-only, no message content. 'rich' surfaces
      // sender handle ("from whom") but never preview text ("what they
      // said"); preview-text would need a Notification Service
      // Extension that decrypts on-device, deferred to Phase 6.
      let title: string;
      let body: string;
      if (kind === 'call') {
        title = showSender ? `@${notice.senderId}` : 'speakeasy';
        body = showSender ? 'Calling…' : 'Incoming call';
      } else {
        title = showSender ? `@${notice.senderId}` : 'speakeasy';
        body = 'New message';
      }
      const key = `${title}\0${body}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.tokens.push(d.pushToken!);
      } else {
        buckets.set(key, { title, body, tokens: [d.pushToken!] });
      }
    }

    const sends: Promise<admin.messaging.BatchResponse>[] = [];
    for (const { title, body, tokens } of buckets.values()) {
      const payload: admin.messaging.MulticastMessage = {
        notification: { title, body },
        data,
        tokens,
      };
      sends.push(admin.messaging(this.app).sendEachForMulticast(payload));
    }
    const responses = await Promise.all(sends);
    const totalSuccesses = responses.reduce((acc, r) => acc + r.successCount, 0);
    const totalFailures = responses.reduce((acc, r) => acc + r.failureCount, 0);
    // rc.55: log every push attempt with its outcome so the next
    // "@x didn't get a push" report is a single fly-logs grep away
    // from knowing whether FCM accepted, rejected, or never tried.
    // Token preview on first 8 chars only (real tokens are ~150 chars
    // and shouldn't be in logs in full).
    // eslint-disable-next-line no-console
    console.info(
      {
        userId: notice.userId,
        kind,
        deviceCount: withPush.length,
        successes: totalSuccesses,
        failures: totalFailures,
        tokenPreview: withPush[0]?.pushToken?.slice(0, 8),
      },
      'push notify: attempted',
    );
    if (totalFailures > 0) {
      const allFailed = responses.flatMap((r) => r.responses.filter((x) => !x.success));
      // eslint-disable-next-line no-console
      console.warn(
        { failures: allFailed.map((f) => f.error?.message) },
        'FCM push: some deliveries failed',
      );
    }
  }
}
