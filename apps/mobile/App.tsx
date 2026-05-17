import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  conversationIdForCommunity,
  conversationIdForDirect,
  conversationIdForGroup,
  newMessageId,
} from '@speakeasy/shared';
import type { NavigationContainerRef } from '@react-navigation/native';
import notifee from '@notifee/react-native';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import type { RootStack } from './src/navigation/RootNavigator.js';
import { useIdentity } from './src/store/identity.js';
import { wipeAllPersistedState } from './src/store/wipe.js';
import { useBlocks } from './src/store/blocks.js';
import { useOwnership } from './src/store/ownership.js';
import { useConversations } from './src/store/conversations.js';
import { useGroups } from './src/store/groups.js';
import { useDistributionIds } from './src/store/distribution-ids.js';
import { useSettings } from './src/store/settings.js';
import { useProfiles } from './src/store/profiles.js';
import { useOnboardingCards } from './src/store/onboarding-cards.js';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider.js';
import { ensureServerBinding } from './src/auth/ensure-enrolled.js';
import { saveAttachmentsToGallery } from './src/attachments/save-to-gallery.js';
import { useUiState } from './src/store/ui.js';
import { useBanner } from './src/store/banner.js';
import { decideBanner } from './src/notifications/banner-policy.js';
import { api, getWsClient, groupMessaging, pushNotifications, signalProtocol, vouchflow } from './src/services.js'; // vouchflow kept — used by post-enrollment refresh effect
import { makeGroupOrchestrator } from './src/crypto/group-orchestration.js';
import { makeMessageRouter } from './src/ws/message-router.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { CallOrchestrator, type CallHistoryEntry } from './src/calls/orchestrator.js';
import { ensureSessionWithPeer } from './src/crypto/session.js';
import { useCalls } from './src/store/calls.js';
import { reactNativeWebRtcPeerFactory } from './src/calls/webrtc-peer.js';
// CallKeepBridge intentionally not imported here — see the deferred-
// init comment in the post-enrollment effect. The bridge module still
// ships in the bundle for the future lazy-start callsite (orchestrator
// or CallScreen mount).
import { diag } from './src/diag/log.js';
import { requestStartupPermissions } from './src/permissions/startup.js';
import { tryRegisterPushToken } from './src/push/register.js';
import { parseAdd } from './src/utils/handle-link.js';
import { colors } from './src/theme/index.js';
import { SplashScreen } from './src/components/SplashScreen.js';
import {
  registerForegroundMessageHandler,
  usePushNavigation,
} from './src/push/push-handler.js';

// Global unhandled-rejection handler — prevents promise rejections
// from crashing the RN host on Android.
type ErrorUtilsGlobal = {
  ErrorUtils?: {
    getGlobalHandler?: () => ((e: Error, isFatal?: boolean) => void) | undefined;
    setGlobalHandler?: (h: (e: Error, isFatal?: boolean) => void) => void;
  };
};
const _origHandler = (globalThis as ErrorUtilsGlobal).ErrorUtils?.getGlobalHandler?.();
(globalThis as ErrorUtilsGlobal).ErrorUtils?.setGlobalHandler?.((e: Error, isFatal?: boolean) => {
  diag('app', 'global error', { message: e.message, isFatal: String(isFatal) });
  if (typeof _origHandler === 'function') _origHandler(e, isFatal);
});

// Register the FCM foreground handler. The background handler is
// registered at module load in push-handler.ts (top-level, Android
// only); notification taps are handled inside usePushNavigation.
registerForegroundMessageHandler();

// Kick off FCM token provisioning now, in parallel with onboarding.
// The first getToken() on a fresh install is slow; starting it here
// lets it finish before registration needs it, instead of racing a
// short first session.
void pushNotifications.warmUp();

/**
 * Minimum visible duration for the SplashScreen. Hydration completes
 * in ~50–200ms on a warm cache; without a floor the splash flashes
 * and disappears before it lands as a brand moment. 1500ms is the
 * shortest we can get away with that still reads as intentional.
 */
const SPLASH_MIN_DURATION_MS = 1500;

/**
 * rc.55: write the system bubble for a finished call into the
 * direct conversation with the peer. Was in CallScreen / VideoCallScreen
 * useEffects keyed on `prev && !active` — fragile when a fresh
 * outgoing call replaced `active` before React committed the
 * intermediate `undefined` render, which dropped the bubble for
 * back-to-back calls.
 *
 * Now driven from the orchestrator's `onCallFinished` deps callback,
 * which fires exactly once per terminal call regardless of UI state.
 */
function writeCallEndedBubble(myUserId: string, entry: CallHistoryEntry): void {
  const cid = useConversations.getState().openDirect(myUserId, entry.peerUserId);
  const wasIncoming = !entry.isCaller;
  const everConnected = entry.durationSec > 0 || entry.reason === 'completed';
  const noun = entry.kind === 'video' ? 'video call' : 'voice call';
  const verbedIncoming = entry.kind === 'video' ? 'video-called' : 'called';
  let text: string;
  if (everConnected) {
    const sec = entry.durationSec;
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    text = `${noun} · ${mm}:${ss}.`;
  } else if (wasIncoming) {
    text = `@${entry.peerUserId} ${verbedIncoming}. you missed it.`;
  } else {
    text = entry.kind === 'video' ? 'you video-called. no answer.' : 'you called. no answer.';
  }
  useConversations.getState().add(cid, {
    id: newMessageId(),
    from: 'system',
    text,
    kind: 'direct',
    sentAt: Date.now(),
    stage: 'sent',
  });
  // Clear the stale "Incoming call" notification for answered or
  // outgoing calls. A *missed incoming* call is left alone — the
  // server's call-end push replaces it with "Missed call" (and stays
  // correctly silent when the app is foregrounded).
  if (everConnected || !wasIncoming) {
    void notifee.cancelNotification(cid);
  }
}

export default function App() {
  const userId = useIdentity((s) => s.userId);
  const hydrated = useIdentity((s) => s.hydrated);
  const navRef = useRef<NavigationContainerRef<RootStack>>(null);
  // Flips true on NavigationContainer's onReady. usePushNavigation must
  // wait for it: a push tapped from a cold start resolves a target
  // before the navigator mounts, and navRef.current?.navigate() would
  // otherwise no-op into a null ref and lose the navigation.
  const [navReady, setNavReady] = useState(false);
  // useState (not useRef) — assigning to a ref doesn't re-render, so the
  // RootNavigator below would never see the orchestrator. State triggers
  // a re-render and the navigator picks up the new prop on next pass.
  const [callOrchestrator, setCallOrchestrator] = useState<CallOrchestrator | undefined>(undefined);
  // Splash hold flag. We render the splash while either (a) stores
  // are still hydrating OR (b) the minimum-display timer hasn't
  // elapsed. The two AND together give us "splash visible at least
  // SPLASH_MIN_DURATION_MS even if hydration is instant".
  const [splashHoldElapsed, setSplashHoldElapsed] = useState(false);
  // Tracks whether the rc.45 fresh-install identity recovery probe
  // has run. Declared up here (not next to its useEffect below)
  // because `showSplash` needs it.
  const [recoveryDone, setRecoveryDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSplashHoldElapsed(true), SPLASH_MIN_DURATION_MS);
    return () => clearTimeout(t);
  }, []);
  // Hold the splash through the recovery probe so users with a
  // restorable identity don't see Onboarding flash before being
  // routed to Conversations. The probe finishes in ~300–800ms on
  // a warm Vouchflow keystore, comfortably inside the 1500ms
  // SPLASH_MIN_DURATION_MS floor.
  const showSplash =
    !hydrated || !splashHoldElapsed || (!userId && !recoveryDone);

  // Pull persisted identity AND conversations off disk on first mount.
  // Renders a blank screen until both are done so the navigator doesn't
  // briefly show Onboarding (no userId yet) and then snap to
  // Conversations (userId arrived) — and so the chat list is populated
  // from disk before the user can interact with it.
  useEffect(() => {
    if (!hydrated) {
      void useIdentity.getState().hydrate();
      void useConversations.getState().hydrate();
      void useGroups.getState().hydrate();
      void useDistributionIds.getState().hydrate();
      void useSettings.getState().hydrate();
      void useProfiles.getState().hydrate();
      void useOnboardingCards.getState().hydrate();
      void useCalls.getState().hydrate();
      void useBlocks.getState().hydrate();
      void useOwnership.getState().hydrate();
    }
  }, [hydrated]);

  // Fresh-install identity recovery — DISABLED (rc.92).
  //
  // The rc.45 recovery flow asked Vouchflow for a fresh deviceToken
  // and probed `GET /v1/users/me` on cold launch when no cached
  // identity was present. Two problems killed it:
  //
  //   1. Mints a Vouchflow deviceToken even when the user is about
  //      to onboard fresh, producing two deviceTokens for one
  //      physical device (the recovery-probe one + the one minted
  //      again during the actual onboarding flow). The push-token
  //      registration race that fell out of this surfaced as
  //      tester15's 2026-05-14 incident: `push.no_devices` for every
  //      message during the window between recovery and the next WS
  //      auth. Server-side mitigation (insert-on-conflict in
  //      `setPushToken`, rc.92) closes the race, but the underlying
  //      dual-deviceToken state is still smelly and breaks future
  //      assumptions.
  //
  //   2. It's a UX wart, not a feature. Reinstall on the same device
  //      is rare; when it happens the user gets to re-pick their
  //      @-handle, which is a fine penalty for the work the path
  //      saves. The "skip onboarding" magic also confuses testers
  //      mid-cycle and burned three investigation sessions chasing
  //      ghosts.
  //
  // The state plumbing (`recoveryDone`, splash hold) stays in place
  // so the splash gate behaves identically — we just flip
  // `recoveryDone` to true immediately after hydration so the
  // onboarding flow renders for any unbound device. If we ever want
  // a "restore your account" flow back, it should be an explicit
  // user gesture (a button on the onboarding screen), not a silent
  // cold-launch probe.
  useEffect(() => {
    if (!hydrated || userId || recoveryDone) return;
    diag('app', 'identity recovery: disabled (rc.92) — proceeding to onboarding');
    setRecoveryDone(true);
  }, [hydrated, userId, recoveryDone]);

  // After hydration, if we have a cached identity, refresh
  // authentication eagerly before any authed request can fire.
  //
  // Why: the persisted `deviceToken` may be stale (Vouchflow's
  // server-side freshness window is ~5min) or missing entirely
  // (reinstall wiped Vouchflow's keystore but Speakeasy's identity
  // somehow survived — adb install -r, dev-build state bleed, etc.).
  // Without this, the navigator renders Conversations and the user
  // can tap things that hit 401 `device_not_found` / `not_enrolled`,
  // each surfaced as a different inline error. Bug report: "many
  // actions fail saying the device is not authenticated".
  //
  // Strategy: call `vouchflow.verify({context: 'login'})` first.
  // The CachingVouchflowClient + native SDK return the in-keystore
  // token if it's fresh (no biometric prompt); otherwise they
  // prompt biometric and re-attest. Then write the fresh token
  // through to the identity store, then re-bind with the server
  // (silent re-enroll if the server forgot us). On hard failure —
  // verify itself rejected, e.g. device removed from Vouchflow's
  // attestation universe — reset identity so the navigator falls
  // back to Onboarding instead of leaving the user stranded on a
  // dead Conversations screen.
  // Idempotent permission catch-up for already-onboarded users. New
  // installs see the dedicated PermissionsStep at end of onboarding;
  // existing installs (whose users were enrolled before the step
  // existed) get prompted here on first launch of rc.39+. The OS only
  // shows a prompt for permissions never decided on, so this is safe
  // to call every launch — already-granted/already-denied = no-op.
  useEffect(() => {
    if (!hydrated || !userId) return;
    void requestStartupPermissions().catch((err) =>
      diag('app', 'startup permissions catch-up threw', { err: String(err) }),
    );
  }, [hydrated, userId]);

  // Phase 6 fix: route push-notification taps to the correct screen.
  // Reads the FCM data payload (conversation_id + notify_kind) and
  // navigates to Chat/GroupChat/IncomingCall instead of always
  // landing on the conversation list. Covers cold start, warm
  // resume, and deferred (background-handler persisted) taps.
  usePushNavigation(navRef, navReady, callOrchestrator);

  // Load (or generate) the local SpeakeasySignalStore identity key.
  // OnboardingFlow's RoomStep calls this once at signup; subsequent
  // app launches need to reload the persisted key into the native
  // module's memory. Without it, group send (which builds an SKDM
  // signed by the identity key) fails immediately with
  // "SpeakeasySignalStore not initialized — call generateIdentityKey
  // first" — direct messages happen to work because their session
  // setup goes through `ensureSessionWithPeer` which loads on demand.
  // Idempotent: the native module returns the existing key on a re-call.
  useEffect(() => {
    if (!hydrated || !userId) return;
    void signalProtocol.generateIdentityKey().catch(async (err) => {
      const msg = String(err);
      diag('app', 'identity-key load FAILED — group send will error', {
        err: msg,
      });
      // rc.80 heal: this exact failure signature is the ghost-identity
      // bug — Android Auto Backup restored AsyncStorage (which holds
      // the JS userId + conversation list) but Vouchflow attestation
      // was correctly excluded, so the deviceToken can't open the
      // SQLCipher store. Wipe every persisted Speakeasy key and
      // clear identity so the next render routes to onboarding with
      // a clean slate. Without this heal, the user finishes
      // onboarding as a new id but still sees the prior identity's
      // conversations (reported with tester9 → tester13 in the
      // rc.79 test cycle).
      const corrupted =
        msg.includes('Vouchflow.cachedDeviceToken is null') ||
        msg.includes('SpeakeasyDb cannot open');
      if (corrupted) {
        diag('app', 'identity-key load corrupted-state — wiping persisted state', {
          userId,
        });
        await wipeAllPersistedState();
        await useIdentity.getState().reset();
      }
    });
  }, [hydrated, userId]);

  useEffect(() => {
    if (!hydrated || !userId) return;
    void (async () => {
      // Only re-verify if the cached deviceToken is missing or older
      // than the server's freshness window. Prior behaviour was to
      // re-attest on every cold launch, which (a) churned the
      // biometric prompt every time the app resumed from a long
      // background, and (b) meant the status pip greyed for a
      // few seconds while we waited on Vouchflow + Play Integrity.
      // The server's window is 24h by default (see VouchflowValidator
      // DEFAULT_MAX_AGE_MS). Mobile re-verifies a comfortable margin
      // before that — 22h — so a token that's still server-valid
      // is NEVER pre-emptively refreshed at launch.
      const FRESHNESS_MS = 22 * 60 * 60_000;
      const { deviceToken: cachedToken, deviceTokenIssuedAt: issuedAt } =
        useIdentity.getState();
      const ageMs = issuedAt ? Date.now() - issuedAt : Number.POSITIVE_INFINITY;
      const tokenStillFresh = !!cachedToken && ageMs < FRESHNESS_MS;

      if (tokenStillFresh) {
        diag('app', 'launch verify skipped — cached token still fresh', {
          userId,
          ageMs,
        });
      } else {
        try {
          const r = await vouchflow.verify({ context: 'login' });
          useIdentity.getState().setDeviceToken(r.deviceToken);
          diag('app', 'launch verify OK', { userId, prevAgeMs: ageMs });
          // Re-register push token after re-verification in case it
          // rotated or wasn't registered on the first launch.
          void tryRegisterPushToken(r.deviceToken).catch(() => {
            /* best-effort */
          });
        } catch (err) {
          diag('app', 'launch verify FAILED — clearing identity', {
            err: String(err),
          });
          // rc.80: also wipe other persisted stores. The launch-verify
          // failure path is hit by the same ghost-identity bug — if
          // we only reset() identity, the conversation list / profiles
          // / groups for the now-orphaned userId stay behind and
          // re-attach to whatever userId the user onboards as next.
          await wipeAllPersistedState();
          await useIdentity.getState().reset();
          return;
        }
      }
      void ensureServerBinding({ signalProtocol, vouchflow });
    })();
  }, [hydrated, userId]);

  // Deep-link handler: when the user (or a peer) scans a Speakeasy QR
  // with their phone camera, the OS hands us a `speakeasy://add?handle=…`
  // URL. We route to the NewChat screen with the handle prefilled so
  // the recipient can confirm + start the chat in one tap.
  //
  // Handles two cases:
  //   - Cold start: the URL came in via the launching intent. We pull
  //     it off `Linking.getInitialURL()` and navigate once the user is
  //     enrolled (otherwise the navigation target doesn't exist yet).
  //   - Warm: the app is already running; `addEventListener('url')`
  //     fires synchronously when the OS hands us a new URL.
  useEffect(() => {
    if (!hydrated || !userId) return;
    let cancelled = false;
    function handleUrl(url: string | null | undefined): void {
      if (!url) return;
      const handle = parseAdd(url);
      if (!handle) {
        diag('app', 'deep-link ignored (not a valid handle URL)', { url });
        return;
      }
      if (handle === userId) {
        diag('app', 'deep-link ignored (self handle)', { handle });
        return;
      }
      // NEW-CONVERSATION.md §6.1: deep-link lands the user on the
      // conversation list with the Find Someone sheet pre-filled.
      // The list reads `pendingFindHandle` on mount/focus and pops
      // the sheet — clearing the field as it consumes it.
      diag('app', 'deep-link → Find sheet', { handle });
      useUiState.getState().setPendingFindHandle(handle);
      navRef.current?.navigate('Home');
    }
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) handleUrl(url);
    });
    const sub = Linking.addEventListener('url', (ev) => handleUrl(ev.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrated, userId]);

  // Open WebSocket once enrolled. Close + reset when identity is cleared.
  // Token comes from the identity store (set at signup); we only fall
  // back to vouchflow.verify() if the store is empty (unexpected — implies
  // we got into App-with-userId without going through OnboardingScreen).
  useEffect(() => {
    if (!userId) return;
    diag('app', 'mounting router for userId', { userId });
    const getToken = async () => {
      const cached = useIdentity.getState().deviceToken;
      if (cached) return cached;
      const r = await vouchflow.verify({ context: 'login' });
      useIdentity.getState().setDeviceToken(r.deviceToken);
      void tryRegisterPushToken(r.deviceToken).catch(() => {
        /* best-effort */
      });
      return r.deviceToken;
    };
    const ws = getWsClient(getToken);
    ws.connect();

    // Phase 2 brand overhaul: ensure the server has a recorded
    // selectedAvatarId for this user. New enrollments don't yet pass
    // through the avatar picker (Phase 3 onboarding rewrite); without
    // this catch-up, peers fetching this user's profile would see
    // null and fall back to the default — which is the deterministic
    // hash of userId, but writing it explicitly avoids an extra round
    // trip every render. Best-effort, fire-and-forget.
    void (async () => {
      const own = useProfiles.getState().byUserId[userId];
      if (own?.selectedAvatarId) return;
      const dt = await getToken().catch(() => undefined);
      if (!dt) return;
      try {
        const fresh = await api.fetchUser(dt, userId);
        if (fresh.selected_avatar_id) {
          useProfiles.getState().set(userId, {
            selectedAvatarId: fresh.selected_avatar_id,
            fetchedAt: Date.now(),
          });
          return;
        }
        // Server doesn't know either — set the deterministic default so
        // the user has a stable identity without needing to visit
        // Settings. The user can pick a different one any time via
        // Settings → Change face.
        const { defaultAnimalForUser } = await import(
          './src/avatars/default.js'
        );
        const seeded = defaultAnimalForUser(userId);
        await api.setAvatar(dt, seeded);
        useProfiles.getState().set(userId, {
          selectedAvatarId: seeded,
          fetchedAt: Date.now(),
        });
      } catch {
        // Non-fatal — peers will fall back to defaultAnimalForUser on
        // their side too. No user-visible breakage.
      }
    })();

    // Phase 5d: register push token on every app start. Token can
    // rotate (FCM invalidates on app reinstall, OS update). Best-effort.
    // Errors are non-fatal — push is a nice-to-have, not a blocker.
    // Also rides along the current notificationPrivacy preference so a
    // user who toggled privacy mode while offline gets it synced up on
    // the next launch even if the inline toggle-time request failed.
    void getToken()
      .then((dt) => tryRegisterPushToken(dt))
      .catch((err) => {
        diag('app', 'push token registration failed (non-fatal)', {
          err: String(err),
        });
      });

    // Replenisher dedupes concurrent prekey-low signals onto a single
    // in-flight round.
    const replenisher = makeReplenisher({ api, signalProtocol, getDeviceToken: getToken });

    // Group orchestrator (Phase 5b) — owns the SKDM bootstrap state and
    // does the per-group send fan-out.
    const orchestrator = makeGroupOrchestrator({
      api,
      signalProtocol,
      groupMessaging,
      ws,
      getDeviceToken: getToken,
      getOrCreateDistributionId: (groupId) =>
        useDistributionIds.getState().getOrCreate(groupId),
    });

    // Set of msgIds we've already shown a banner for. Survives WS
    // flaps so a server redelivery doesn't fire a duplicate banner.
    // (`useConversations.add` dedupes the bubble; this dedupes the
    // notification too.) Bounded by message volume per session —
    // pruned only on app restart.
    const notifiedMsgIds = new Set<string>();

    // Voice-call orchestrator. Owns the WebRTC peer connection and
    // the call_* WS frame round-trip. Reuses the same Signal session
    // ChatScreen does, so calls go through the existing 1:1 crypto.
    //
    // Wrapped so a constructor failure in any new dep can't crash the
    // post-enrollment effect. Messaging keeps working even if calling
    // is broken.
    let callOrch: CallOrchestrator | undefined;
    try {
      callOrch = new CallOrchestrator({
        myUserId: userId,
        signalProtocol,
        api,
        peerFactory: reactNativeWebRtcPeerFactory,
        getDeviceToken: getToken,
        send: (frame) => ws.enqueueSend(frame),
        ensureSessionWithPeer,
        onStateChange: (call) => useCalls.getState().setActive(call),
        onCallFinished: (entry) => {
          useCalls.getState().recordHistory(entry);
          // rc.55: write the chat-history system bubble here, not in
          // CallScreen/VideoCallScreen. The screen-side useEffect was
          // gated on `prev && !active`, which is fragile when a fresh
          // outgoing call replaces `active` before React commits the
          // intermediate `undefined` render. The orchestrator's
          // onCallFinished fires exactly once per terminal call, so
          // this is the right place. Idempotent if the screen-side
          // path also runs (dedupe by message id is already in
          // conversations.add).
          writeCallEndedBubble(userId, entry);
        },
        getAllowIncomingCalls: () =>
          useSettings.getState().allowIncomingCalls,
      });
      setCallOrchestrator(callOrch);
    } catch (err) {
      diag('app', 'CallOrchestrator init FAILED — calls disabled', {
        err: String(err),
      });
    }

    // CallKeep — DEFERRED at app launch. `RNCallKeep.setup()` calls
    // `telecomManager.registerPhoneAccount()` on Android, which the OS
    // responds to with a system "Calling accounts" Settings dialog
    // immediately after enrollment (Tier B run 25514218352 caught
    // this — emptied AlertDialog covered the conversations screen,
    // tapping OK redirected to system Settings → Calling accounts,
    // never returning to our app).
    //
    // Auto-starting the bridge at app launch means every fresh-install
    // user gets that dialog seconds after enrollment, before they've
    // placed or received a single call. That's terrible UX.
    //
    // Defer: orchestrator/screen calls `bridge.start()` lazily right
    // before the first call (CallScreen mount or call_offer arrival).
    // Then the system dialog only appears in a call context where the
    // permission ask makes sense, and Tier B flows that don't touch
    // the dialer never see the dialog at all. The in-app
    // IncomingCallScreen / CallScreen continue to handle every call
    // exactly as they did pre-0.4.35; CallKit/ConnectionService is
    // additive when present, not required.

    // Single ws.subscribe wired to the unified router. Every screen
    // (ChatScreen, GroupChatScreen, future CommunityScreen) reads from
    // the conversations store; nobody owns the ws subscription anymore.
    const router = makeMessageRouter({
      myUserId: userId,
      api,
      signalProtocol,
      groupMessaging,
      ws,
      orchestrator,
      // Optional — when callOrch failed to construct, we drop call_*
      // frames; messaging still works.
      onCallFrame: callOrch
        ? (frame) => void callOrch!.handleFrame(frame)
        : undefined,
      // rc.84 — re-sync push token on every WS handshake. Closes
      // the post-signup black hole where the device row exists but
      // push_token is NULL, causing every push to be silently
      // dropped until the user next cold-launches the app (see
      // MessageRouterDeps.onAuthed doc for the full incident
      // analysis). `tryRegisterPushToken` is idempotent + dedupes,
      // so this is a no-op when registration already succeeded.
      onAuthed: () => {
        const dt = useIdentity.getState().deviceToken;
        if (!dt) return;
        void tryRegisterPushToken(dt).catch((err) => {
          diag('app', 'authed push re-register failed (non-fatal)', {
            err: String(err),
          });
        });
      },
      onPrekeysLow: () => void replenisher.trigger(),
      addToConversation: (conversationId, msg) =>
        useConversations.getState().add(conversationId, msg),
      markDelivered: (msgId) =>
        useConversations.getState().markDelivered(msgId),
      markMessageRead: (msgId, readAt) =>
        useConversations.getState().markMessageRead(msgId, readAt),
      ensureGroupHydrated: async (groupId) => {
        // Skip if already populated with members. We re-fetch every
        // hour at most via metadataFetchedAt — for now any non-empty
        // member set means we don't need to round-trip again.
        const existing = useGroups.getState().byId[groupId];
        if (existing && existing.members.length > 0) return;
        const dt = await getToken().catch(() => undefined);
        if (!dt) return;
        try {
          const [groupRes, rosterRes] = await Promise.all([
            api.fetchGroup(dt, groupId),
            api.listGroupMembers(dt, groupId),
          ]);
          const memberIds = rosterRes.members;
          const fallbackName = (() => {
            // No name set server-side and no local override — build a
            // "Room with @x, @y" line from members, capped to keep it
            // short. The user can rename via Group Settings.
            const others = memberIds.filter((m) => m !== userId).slice(0, 3);
            if (others.length === 0) return 'Room';
            return `Room with @${others.join(', @')}`;
          })();
          useGroups.getState().upsert({
            id: groupId,
            name: groupRes.name ?? fallbackName,
            members: memberIds,
            createdAt: Date.now(),
            createdBy: groupRes.created_by,
            metadataFetchedAt: Date.now(),
          });
          diag('group', 'ensureGroupHydrated populated', {
            groupId,
            name: groupRes.name ?? '(fallback)',
            memberCount: memberIds.length,
          });
        } catch (err) {
          diag('group', 'ensureGroupHydrated fetch failed', {
            groupId,
            err: String(err),
          });
        }
      },
      conversationIdFor: (kind, senderId, to) => {
        switch (kind) {
          case 'direct':
            return conversationIdForDirect(senderId, to);
          case 'group':
            return conversationIdForGroup(to);
          case 'community':
            return conversationIdForCommunity(to);
        }
      },
      // Best-effort: photos/gifs land in the device gallery so the
      // recipient can revisit them outside Speakeasy (and so the
      // dissolve TTL doesn't take them away forever). Files are
      // skipped — there's no system "documents" gallery analog.
      onInboundAttachments: (attachments) => {
        void saveAttachmentsToGallery(attachments);
      },
      notifyInbound: ({ msgId, from, text, target }) => {
        if (notifiedMsgIds.has(msgId)) return;
        notifiedMsgIds.add(msgId);
        // The branching logic (global toggle / active-conv suppress
        // / per-conversation mute / in-call suppress) lives in
        // `banner-policy.ts` so unit tests can exercise each branch
        // without spinning up a navigator or harness.
        const decision = decideBanner(
          {
            myUserId: userId,
            inboundFrom: from,
            inboundText: text,
            inboundTarget: target,
            inAppNotificationsEnabled:
              useSettings.getState().inAppNotificationsEnabled,
            activeConversationId:
              useUiState.getState().activeConversationId,
            isMuted: (cid: string) =>
              !!useConversations.getState().byId[cid]?.muted,
            activeCall: useCalls.getState().active,
          },
          msgId,
        );
        // rc.50: log which branch fires so the next "no foreground
        // notifications" report tells us at a glance whether the
        // banner was suppressed (and why) or actually shown. Without
        // this, "no banner" could be 5 different things and each diag
        // round-trip is one less narrowing pass.
        diag('banner', `decision: ${decision.kind}`, {
          msgId,
          from,
          activeConv: useUiState.getState().activeConversationId,
          inAppEnabled:
            useSettings.getState().inAppNotificationsEnabled,
        });
        if (decision.kind === 'show') {
          useBanner.getState().show(decision.banner);
        }
      },
    });

    const unsubscribe = ws.subscribe(router);

    // App lifecycle: when the OS pauses the app, the underlying TCP
    // socket may get killed silently. On resume the WS client thinks
    // it's still connected, the next ws.send() throws, and the user
    // sees a crash. Force a reconnect on `active` if we're not
    // already in `authed` state.
    const lifecycleSub = AppState.addEventListener('change', (next) => {
      diag('app', 'AppState change', { next, wsState: ws.getState() });
      if (next === 'active') {
        const state = ws.getState();
        // `reconnecting` already has a timer pending — the WS client
        // turned `connect()` into a no-op for that state in the loop
        // fix, so calling it would just produce a misleading
        // "forcing reconnect" log line. Skip and let the timer fire.
        if (
          state !== 'authed' &&
          state !== 'authenticating' &&
          state !== 'connecting' &&
          state !== 'reconnecting'
        ) {
          diag('app', 'AppState active → forcing reconnect', { prevState: state });
          try {
            ws.connect();
          } catch (err) {
            diag('app', 'reconnect threw', { err: String(err) });
          }
        }
        // Re-attempt push-token registration on every foreground.
        // Catches the case where a user denied notifications during
        // onboarding then later granted via system Settings — without
        // this, the cold-launch registration is the only chance and
        // we'd never recover. Idempotent against the server.
        void getToken()
          .then((dt) => tryRegisterPushToken(dt))
          .catch(() => {
            /* best-effort */
          });
      } else if (next === 'background' || next === 'inactive') {
        // Close the WS proactively so the server routes incoming
        // messages through push instead of the (still-alive)
        // WebSocket. Without this, Android can keep the TCP socket
        // open for minutes after the app backgrounds, during which
        // messages arrive via WS but no system banner is shown
        // (the in-app banner only fires when the app is foreground).
        // User-reported: friend not getting push notifications even
        // though server-side push token is registered + FCM accepts.
        // Reconnect on `active` happens above and is fast, so brief
        // foreground returns don't lose any state.
        //
        // Skip when there's an active call — closing the WS during
        // a call would drop the call_ice/call_end frames mid-stream.
        const callActive = !!useCalls.getState().active;
        if (ws.getState() === 'authed' && !callActive) {
          diag('app', 'AppState background → closing WS for push routing');
          try {
            ws.close();
          } catch (err) {
            diag('app', 'background close threw', { err: String(err) });
          }
        } else if (callActive) {
          diag('app', 'AppState background → keeping WS (call active)');
        }
      }
    });

    // Bring the IncomingCallScreen up automatically when the
    // orchestrator transitions into `incoming_ringing`.
    const callsUnsub = useCalls.subscribe((s, prev) => {
      if (
        s.active?.stage === 'incoming_ringing' &&
        prev?.active?.stage !== 'incoming_ringing'
      ) {
        navRef.current?.navigate('IncomingCall');
      }
    });

    return () => {
      diag('app', 'cleanup router for userId', { userId });
      lifecycleSub.remove();
      unsubscribe();
      callsUnsub();
      setCallOrchestrator(undefined);
      ws.close();
    };
  }, [userId]);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        {!showSplash ? (
          <RootNavigator
            navRef={navRef}
            onReady={() => setNavReady(true)}
            callOrchestrator={callOrchestrator}
            onBannerTap={(target) => {
              if (target.kind === 'direct') {
                navRef.current?.navigate('Chat', { peerId: target.peerId });
              } else {
                navRef.current?.navigate('GroupChat', { groupId: target.groupId });
              }
            }}
          />
        ) : (
          <SplashScreen />
        )}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * StatusBar that flips with the active theme. Lives inside the
 * ThemeProvider so it can read `useTheme()`. The status bar is owned
 * by the OS shell, so backgroundColor here paints the Android tinted
 * area to match the workspace canvas (or stays dark on the brand
 * canvas — Onboarding / IdReveal handle their own status-bar color
 * via their SafeAreaView).
 */
function ThemedStatusBar(): React.JSX.Element {
  const t = useTheme();
  return (
    <StatusBar
      barStyle={t.mode === 'dark' ? 'light-content' : 'dark-content'}
      backgroundColor={t.canvas}
    />
  );
}
