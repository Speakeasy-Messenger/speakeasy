// firebase-admin ships as a CJS module with a single default export; the
// `import * as` namespace shape only exposes `.default` under Node's
// ESM interop. Use the default-import form so `admin.credential.cert`
// resolves at the top level. (Crash repro: alpha-0.4.30 startup —
// `Cannot read properties of undefined (reading 'cert')`.)
import admin from 'firebase-admin';
import type { PushDeliveryNotice, PushProvider } from './push.js';
import type { DevicesRepo } from '../db/devices.js';
import type { EventLogRepo } from '../db/event-log.js';

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
    private readonly eventLog: EventLogRepo,
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
      void this.eventLog
        .record({
          eventType: 'push.no_devices',
          userId: notice.userId,
          payload: {
            totalDevices: userDevices.length,
            kind: notice.kind ?? 'message',
            conversationId: notice.conversationId,
          },
        })
        .catch(() => {
          /* eventLog is best-effort */
        });
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
    // Bucket by (title, body, platform) so we can build
    // platform-specific payloads: data-only for Android (the
    // onMessage handler suppresses auto-display when the app is
    // foregrounded, and the OS auto-displays when the app is
    // backgrounded/killed), and notification+data for iOS (APNs
    // needs the alert key to display when the app is killed).
    const buckets = new Map<string, { title: string; body: string; platform: 'ios' | 'android'; tokens: string[] }>();
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
      const platform = d.platform ?? 'android';
      const key = `${title}\0${body}\0${platform}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.tokens.push(d.pushToken!);
      } else {
        buckets.set(key, { title, body, platform, tokens: [d.pushToken!] });
      }
    }

    // Track which tokens went into which send so we can correlate
    // per-response error codes back to the original FCM tokens in the
    // failure handler below. `sendEachForMulticast` returns
    // `responses[i]` aligned with `tokens[i]`, so a parallel array
    // is the lightest way to carry that mapping out of the loop.
    const sends: { send: Promise<admin.messaging.BatchResponse>; tokens: string[] }[] = [];
    for (const { title, body, platform, tokens } of buckets.values()) {
      // Android: data-only message. When the app is foregrounded,
      // onMessage fires and the library suppresses auto-display.
      // When the app is backgrounded/killed, Android still auto-
      // displays the notification because FCM shows data-only
      // messages in the system tray for apps with a default
      // notification channel configured in AndroidManifest.xml.
      //
      // Actually, data-only messages on Android do NOT auto-display.
      // We need the notification key for background/killed state.
      // The duplicate-notification fix is purely on the client side:
      // onMessage registered at module level suppresses auto-display
      // when the app is foregrounded. We keep the notification key
      // here so the OS still shows a banner when the app is in the
      // background.
      if (platform === 'android') {
        const payload: admin.messaging.MulticastMessage = {
          data,
          android: {
            priority: 'high' as const,
            notification: {
              title,
              body,
              channelId: 'speakeasy_default',
              clickAction: 'OPEN_FROM_PUSH',
            },
          },
          tokens,
        };
        sends.push({
          send: admin.messaging(this.app).sendEachForMulticast(payload),
          tokens,
        });
      } else {
        // iOS: include top-level notification for APNs to display
        // when the app is killed, plus content-available for
        // background delivery (triggers UNNotificationServiceExtension
        // or wakes the app briefly).
        const payload: admin.messaging.MulticastMessage = {
          notification: { title, body },
          data,
          apns: {
            payload: {
              aps: {
                'content-available': 1,
                'mutable-content': 1,
              },
            },
          },
          tokens,
        };
        sends.push({
          send: admin.messaging(this.app).sendEachForMulticast(payload),
          tokens,
        });
      }
    }
    const responses = await Promise.all(sends.map((s) => s.send));
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
    void this.eventLog
      .record({
        eventType: 'push.attempted',
        userId: notice.userId,
        payload: {
          kind,
          deviceCount: withPush.length,
          successes: totalSuccesses,
          failures: totalFailures,
          tokenPreview: withPush[0]?.pushToken?.slice(0, 8),
          conversationId: notice.conversationId,
          senderId: notice.senderId,
        },
      })
      .catch(() => {
        /* eventLog is best-effort */
      });
    if (totalFailures > 0) {
      // Flatten per-token failures with their originating FCM token
      // so we can both (a) log specifically and (b) reap dead tokens.
      // FCM's `messaging/registration-token-not-registered`
      // (UNREGISTERED) and `messaging/invalid-registration-token`
      // are terminal — the app was uninstalled, data cleared, or the
      // token rotated. Continuing to send to them wastes FCM quota
      // and pollutes `push.attempted` aggregates with phantom
      // successes (FCM accepts dead tokens for a small grace window
      // after rotation — exactly the "successes:1 but no banner"
      // pattern we kept chasing). Reap them here so the next
      // notifyDelivery for this user filters them out at
      // `withPush = userDevices.filter(d => d.pushToken)`.
      const perTokenFailures: { token: string; code?: string; message?: string }[] = [];
      for (let i = 0; i < responses.length; i++) {
        const resp = responses[i]!;
        const sendTokens = sends[i]!.tokens;
        resp.responses.forEach((r, j) => {
          if (!r.success) {
            perTokenFailures.push({
              token: sendTokens[j]!,
              code: r.error?.code,
              message: r.error?.message,
            });
          }
        });
      }
      // eslint-disable-next-line no-console
      console.warn(
        { failures: perTokenFailures.map((f) => ({ code: f.code, message: f.message })) },
        'FCM push: some deliveries failed',
      );
      const deadCodes = new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ]);
      const reaped: string[] = [];
      for (const f of perTokenFailures) {
        if (f.code && deadCodes.has(f.code)) {
          try {
            await this.devices.clearPushToken({
              pushToken: f.token,
              reason: `fcm:${f.code}`,
            });
            reaped.push(f.token.slice(0, 8));
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              { err: (err as Error).message },
              'FCM push: clearPushToken failed',
            );
          }
        }
      }
      void this.eventLog
        .record({
          eventType: 'push.fcm_failure',
          userId: notice.userId,
          payload: {
            failures: perTokenFailures.map(
              (f) => f.message ?? f.code ?? 'unknown',
            ),
            successes: totalSuccesses,
            kind,
            reapedTokenPreviews: reaped,
          },
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }
}
