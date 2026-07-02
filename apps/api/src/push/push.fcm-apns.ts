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
 * Max base64 ciphertext length to forward in the FCM `data` block.
 * FCM caps `data` at 4 KB total; the other fields + keys cost ~250 B,
 * so cap the ciphertext at 3.5 KB. Anything larger is dropped and the
 * device falls back to a generic "New message".
 */
const CIPHERTEXT_MAX_B64 = 3500;

function ciphertextEligible(notice: PushDeliveryNotice): boolean {
  return (
    (notice.kind ?? 'message') === 'message' &&
    !!notice.ciphertext &&
    !!notice.senderId &&
    notice.ciphertext.length <= CIPHERTEXT_MAX_B64
  );
}

export function buildBasePushData(notice: PushDeliveryNotice): Record<string, string> {
  return {
    conversation_id: notice.conversationId,
    msg_type: notice.msgType,
    notify_kind: notice.kind ?? 'message',
  };
}

/**
 * Resolve the banner title + body for one device's privacy setting.
 *
 * Privacy-aware, content-free (the device decrypts the forwarded
 * ciphertext and overrides the body when it can):
 *   - call           → "@sender" / ringer copy, or generic when private/sealed
 *   - group message  → the room name (rich) so it reads "<Group> · New
 *                      message"; generic for private devices
 *   - direct message → "@sender" (rich) or generic
 *
 * `notice.body` is the @speaker exception — plaintext announcements the
 * server legitimately has.
 */
export function resolveBannerCopy(
  notice: PushDeliveryNotice,
  privacy: 'rich' | 'private',
): { title: string; body: string } {
  const showSender = privacy === 'rich' && !!notice.senderId;
  if ((notice.kind ?? 'message') === 'call') {
    const video = notice.callVideo === true;
    return {
      title: showSender ? `@${notice.senderId}` : 'speakeasy',
      body:
        notice.callEvent === 'missed'
          ? video
            ? 'Missed video call'
            : 'Missed call'
          : showSender
            ? video
              ? 'Video calling…'
              : 'Calling…'
            : video
              ? 'Incoming video call'
              : 'Incoming call',
    };
  }
  const fallbackBody = privacy === 'rich' && notice.body ? notice.body : 'New message';
  if (notice.msgType === 'group') {
    return {
      title: privacy === 'rich' && notice.groupName ? notice.groupName : 'speakeasy',
      body: fallbackBody,
    };
  }
  return {
    title: showSender ? `@${notice.senderId}` : 'speakeasy',
    body: fallbackBody,
  };
}

export function buildIosPushData(
  notice: PushDeliveryNotice,
  privacy: 'rich' | 'private',
): Record<string, string> {
  const data = buildBasePushData(notice);
  if (notice.messageId) data.message_id = notice.messageId;
  if (notice.senderId) data.sender_id = notice.senderId;
  if (ciphertextEligible(notice) && privacy === 'rich') {
    data.ciphertext = notice.ciphertext!;
  }
  return data;
}

/**
 * Build the FCM message for one Android bucket (devices sharing the same
 * title/body/privacy). The privacy split is the whole point:
 *
 * 'rich' → data-only (no `notification` block) so the headless handler
 *   runs to decrypt the forwarded ciphertext and render the real text.
 * 'private' → an `android.notification` block so the OS renders the banner
 *   immediately even with the process dead. Private devices opt out of the
 *   decrypted preview, so they gain nothing from the data-only path but
 *   pay its cost: Android defers/kills a data-only message's handler in
 *   Doze / App-Standby, so the banner only surfaces on the next foreground
 *   (the "batch of delayed notifications" report). Routed to the
 *   IMPORTANCE_HIGH `speakeasy_default` channel pre-created in MainActivity.
 *
 * The `data` block rides along either way for tap-routing (conversation_id)
 * and the foreground/onMessage path. Exported so the privacy split is
 * unit-testable without a Firebase mock.
 */
export function buildAndroidPushMessage(
  notice: PushDeliveryNotice,
  opts: { title: string; body: string; privacy: 'rich' | 'private'; tokens: string[] },
): admin.messaging.MulticastMessage {
  const { title, body, privacy, tokens } = opts;
  const data: Record<string, string> = { ...buildBasePushData(notice), title, body };
  if (notice.messageId) data.message_id = notice.messageId;
  if (notice.senderId) data.sender_id = notice.senderId;
  // Ciphertext only for 'rich' devices — 'private' devices opt out of the
  // content preview, so they never receive it.
  if (ciphertextEligible(notice) && privacy === 'rich') {
    data.ciphertext = notice.ciphertext!;
  }
  const android: admin.messaging.AndroidConfig = { priority: 'high' };
  if (privacy === 'private') {
    android.notification = { title, body, channelId: 'speakeasy_default' };
  }
  return { data, android, tokens };
}

/**
 * Production push provider — FCM (Android) + APNs (iOS).
 *
 * Android is **data-only**: no `notification` block, so the headless
 * background handler always runs and renders the notification itself —
 * letting it decrypt the forwarded ciphertext and show the real message
 * text ('rich' devices). 'private' devices and sealed/oversized messages
 * get no ciphertext and fall back to a generic banner. iOS still uses an
 * APNs `notification` block (on-device rendering deferred with iOS push).
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
    // banner copy + privacy so every device sees its preferred
    // treatment in one batched FCM call. Sealed senderId is forced to
    // undefined upstream (handler.ts doesn't pass it through) so 'rich'
    // devices still degrade gracefully when the message can't be
    // attributed.
    const kind = notice.kind ?? 'message';
    // Bucket by (title, body, platform, privacy) so each bucket maps to
    // one FCM payload. Android is data-only (the headless handler
    // renders + may decrypt); iOS keeps a notification block.
    const buckets = new Map<
      string,
      {
        title: string;
        body: string;
        platform: 'ios' | 'android';
        privacy: 'rich' | 'private';
        tokens: string[];
      }
    >();
    for (const d of withPush) {
      const privacy = d.notificationPrivacy ?? 'rich';
      const { title, body } = resolveBannerCopy(notice, privacy);
      const platform = d.platform ?? 'android';
      const key = `${title}\0${body}\0${platform}\0${privacy}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.tokens.push(d.pushToken!);
      } else {
        buckets.set(key, { title, body, platform, privacy, tokens: [d.pushToken!] });
      }
    }

    // Track which tokens went into which send so we can correlate
    // per-response error codes back to the original FCM tokens in the
    // failure handler below. `sendEachForMulticast` returns
    // `responses[i]` aligned with `tokens[i]`, so a parallel array
    // is the lightest way to carry that mapping out of the loop.
    const sends: { send: Promise<admin.messaging.BatchResponse>; tokens: string[] }[] = [];
    for (const { title, body, platform, privacy, tokens } of buckets.values()) {
      // Android delivery splits by privacy — see buildAndroidPushMessage.
      // 'rich' stays data-only (headless handler decrypts + renders the
      // real text); 'private' gets a real notification block so the OS
      // shows the banner immediately even with the process dead, instead
      // of the data-only message being deferred by Doze until the next
      // foreground.
      if (platform === 'android') {
        const payload = buildAndroidPushMessage(notice, { title, body, privacy, tokens });
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
          data: buildIosPushData(notice, privacy),
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
