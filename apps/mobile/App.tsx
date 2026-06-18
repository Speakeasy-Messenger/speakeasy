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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import type { RootStack } from './src/navigation/RootNavigator.js';
import { AvatarCacheWarmer } from './src/avatars/AvatarCacheWarmer.js';
import { PrivacyCover } from './src/components/PrivacyCover.js';
import { GroupMarkCacheWarmer } from './src/avatars/GroupMarkCacheWarmer.js';
import { useIdentity } from './src/store/identity.js';
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
import {
  getCachedDeviceTokenOrThrow,
  verifyDeviceWithExplanation,
} from './src/auth/verify-device.js';
import { saveAttachmentsToGallery } from './src/attachments/save-to-gallery.js';
import { useUiState } from './src/store/ui.js';
import { consumeStoreResetFlag } from './src/native/db-state.js';
import {
  disposeFilter,
  wrapTrackWithFilter,
} from './src/native/voice-filter.js';
import {
  formantSemitonesForProfile,
  semitonesForProfile,
} from './src/calls/voice-filter-profiles.js';
import { attachFeatureEventListener } from './src/calls/feature-event-listener.js';
import { useBanner } from './src/store/banner.js';
import { decideBanner } from './src/notifications/banner-policy.js';
import { api, getWsClient, groupMessaging, pushNotifications, signalProtocol, vouchflow } from './src/services.js'; // vouchflow kept — used by post-enrollment refresh effect
import { makeGroupOrchestrator } from './src/crypto/group-orchestration.js';
import { makeMessageRouter } from './src/ws/message-router.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { CallOrchestrator, type CallHistoryEntry } from './src/calls/orchestrator.js';
import { ensureSessionWithPeer } from './src/crypto/session.js';
import { useCalls } from './src/store/calls.js';
import { setShowWhenLocked, shouldShowOverLockScreen } from './src/native/lock-screen.js';
import { usePeerAnimation } from './src/store/peer-animation.js';
import { reactNativeWebRtcPeerFactory } from './src/calls/webrtc-peer.js';
// CallKeepBridge intentionally not imported here — see the deferred-
// init comment in the post-enrollment effect. The bridge module still
// ships in the bundle for the future lazy-start callsite (orchestrator
// or CallScreen mount).
import { diag, loadPersistedDiag, persistDiagNow } from './src/diag/log.js';
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
// rc.10 — kick off the previous-session diag load as early as
// possible (BEFORE any diag() call in the import chain below
// could schedule a persist). `loadPersistedDiag` sets an in-flight
// gate inside log.ts that holds back persist writes until the load
// completes, so doing this synchronously at module-eval time stops
// a too-early throttled persist from clobbering the previous
// session's buffer before we've had a chance to read it.
void loadPersistedDiag();

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
 * AsyncStorage flag marking that the first-launch splash floor has
 * already been served. Present → skip the artificial hold on every
 * subsequent cold start.
 */
const SPLASH_SEEN_KEY = 'speakeasy.splash.seenV1';

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
  // Per-kind noun + verb. Private extends the same grammar as voice /
  // video so the chat-history reads in one voice. The Private noun is
  // "private call" (lowercase) to match "voice call" / "video call".
  let noun: string;
  let verbedIncoming: string;
  let outgoingNoAnswer: string;
  switch (entry.kind) {
    case 'video':
      noun = 'video call';
      verbedIncoming = 'video-called';
      outgoingNoAnswer = 'you video-called. no answer.';
      break;
    case 'private':
      noun = 'private call';
      verbedIncoming = 'private-called';
      outgoingNoAnswer = 'you tried to start a private call. no answer.';
      break;
    default:
      noun = 'voice call';
      verbedIncoming = 'called';
      outgoingNoAnswer = 'you called. no answer.';
  }
  let text: string;
  // Filter-failure bubbles are distinct from social misses. The whole
  // point of the new wire reasons (locked in Phase 5j) is that the
  // user can tell "they declined me" from "their phone couldn't run
  // the filter" — collapsing both to "no answer" would re-open the
  // Codex tension #5 social-friction pain the plan was preventing.
  if (entry.reason === 'filter_failure') {
    text = "private call couldn't start on this device.";
  } else if (entry.reason === 'peer_filter_failure') {
    text = 'private call ended due to a technical issue on the other end.';
  } else if (everConnected) {
    const sec = entry.durationSec;
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    text = `${noun} · ${mm}:${ss}.`;
  } else if (wasIncoming) {
    text = `@${entry.peerUserId} ${verbedIncoming}. you missed it.`;
  } else {
    text = outgoingNoAnswer;
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

// rc.* diag: throttled peer-animation-frame-rate counter. "Face moved
// for a bit then stopped" → did the data-channel frames STOP arriving
// (bug), or did the peer just go quiet (frames keep coming, values
// hold — correct)? Logged every ~2s; a drop to 0 pinpoints a freeze.
let _apfCount = 0;
let _apfLastLog = 0;
let _apfLastApply = 0;
// How long a one-shot acoustic event (laugh/gasp/sigh/hmm) stays "active"
// before the peer-animation store reverts it to 'none'. ~Matches the event
// overlay's animation length; keeps a stale event from pinning the eyes.
const EVENT_HOLD_MS = 1600;

export default function App() {
  const userId = useIdentity((s) => s.userId);
  const deviceToken = useIdentity((s) => s.deviceToken);
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
    // The 1500ms artificial floor is a first-launch-after-install
    // brand moment — not something to repeat on every cold start.
    // Android frequently kills a backgrounded process, so without
    // this gate the floor reapplied every time the app was reopened
    // (user feedback, rc.104). After the first launch we skip the
    // floor entirely; the splash then shows only for the genuine
    // hydration window (~50–200ms).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      let seen = false;
      try {
        seen = (await AsyncStorage.getItem(SPLASH_SEEN_KEY)) !== null;
      } catch {
        // Treat a read failure as not-seen — worst case is one extra
        // hold, never a missing brand moment.
      }
      if (cancelled) return;
      if (seen) {
        setSplashHoldElapsed(true);
        return;
      }
      timer = setTimeout(() => {
        if (!cancelled) setSplashHoldElapsed(true);
      }, SPLASH_MIN_DURATION_MS);
      void AsyncStorage.setItem(SPLASH_SEEN_KEY, '1').catch(() => {});
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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
  // Strategy: only refresh when the cached token is missing/stale.
  // If a real Vouchflow verify is needed, show an explanation first;
  // the native passkey/biometric sheet opens only after the user taps
  // Continue. Then write the fresh token through to the identity
  // store and re-bind with the server (silent re-enroll if the server
  // forgot us). Hard failures keep the identity intact; explicit
  // delete-account is the only local identity wipe path.
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

  // Check whether the native DB layer wiped the encrypted store on
  // this launch (upgrade-time orphan cleanup, or the rare lost-key
  // recovery). The flag is one-shot — consuming it clears it — so a
  // dismissed banner doesn't reappear next launch. Only runs once we
  // know there's an enrolled user, otherwise an unenrolled fresh
  // install would show the banner with nothing to say it about.
  useEffect(() => {
    if (!hydrated || !userId) return;
    void consumeStoreResetFlag()
      .then((wasReset) => {
        if (!wasReset) return;
        diag('app', 'local store was reset by the native DB layer', { userId });
        useUiState.getState().showStoreResetBanner();
      })
      .catch(() => {
        /* best-effort — the banner is a UX nicety, not a correctness gate */
      });
  }, [hydrated, userId]);

  // Phase 6 fix: route push-notification taps to the correct screen.
  // Reads the FCM data payload (conversation_id + notify_kind) and
  // navigates to Chat/GroupChat/IncomingCall instead of always
  // landing on the conversation list. Covers cold start, warm
  // resume, and deferred (background-handler persisted) taps.
  usePushNavigation(navRef, navReady, callOrchestrator);

  // Allow the app over the lock screen ONLY while a call is live.
  //
  // These OS flags (showWhenLocked / turnScreenOn) used to be static
  // manifest attributes on MainActivity so an incoming call could ring
  // over the lock screen — but static attributes apply to the whole app
  // forever, so locking the device on the chat list and pressing power
  // surfaced the chat list over the lock screen (a privacy leak, user
  // report 2026-06). We now subscribe to the call store and toggle the
  // flags programmatically: on for any active, non-ended call (covers
  // incoming ringing and a call answered from the lock screen), off the
  // moment it ends or there's no call. No-ops off-Android.
  useEffect(() => {
    const apply = (stage: string | undefined) => {
      setShowWhenLocked(shouldShowOverLockScreen(stage));
    };
    apply(useCalls.getState().active?.stage);
    return useCalls.subscribe((s) => apply(s.active?.stage));
  }, []);

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
    void signalProtocol.generateIdentityKey().catch((err) => {
      const msg = String(err);
      diag('app', 'identity-key load FAILED — group send will error', {
        err: msg,
      });
      // This failure signature ("cachedDeviceToken is null" /
      // "SpeakeasyDb cannot open") used to trigger a full
      // wipeAllPersistedState() + identity reset, to heal the rc.80
      // Android Auto-Backup ghost-identity bug. Removed: the signature
      // also fires on a harmless startup race (Vouchflow native
      // singleton not ready yet), and silently destroying the user's
      // account on a transient error is never acceptable. New
      // ghost-identity cases are already prevented by the
      // data_extraction_rules.xml RKStorage exclusion. The identity is
      // wiped only by explicit user action (DeleteAccountScreen).
      const storeOpenError =
        msg.includes('Vouchflow.cachedDeviceToken is null') ||
        msg.includes('SpeakeasyDb cannot open');
      if (storeOpenError) {
        diag('app', 'identity-key load: store-open error (not wiping)', {
          userId,
        });
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
      // Vouchflow re-verification is intentionally rare. Mobile treats
      // a successful verification as fresh for 30 days; the server must
      // be configured with a matching VOUCHFLOW_MAX_VERIFICATION_AGE_MS.
      const FRESHNESS_MS = 30 * 24 * 60 * 60_000;
      const { deviceToken: cachedToken, deviceTokenIssuedAt: issuedAt } =
        useIdentity.getState();
      const ageMs = issuedAt ? Date.now() - issuedAt : Number.POSITIVE_INFINITY;
      const tokenStillFresh = !!cachedToken && ageMs < FRESHNESS_MS;

      if (tokenStillFresh) {
        diag('app', 'launch verify skipped — cached token still fresh', {
          userId,
          ageMs,
        });
      } else if (!cachedToken) {
        // Genuinely no token (fresh install over existing account, or
        // recovery-path reset). VerifyGateScreen handles this case as
        // a non-dismissible full-screen prompt — don't ALSO pop the
        // launch-refresh sheet here. Doing so would race the gate's
        // own vouchflow.verify call and produce a double biometric
        // prompt.
        diag('app', 'launch verify deferred — VerifyGate will handle', {
          userId,
        });
      } else {
        try {
          const r = await verifyDeviceWithExplanation(vouchflow, 'launch_refresh');
          useIdentity.getState().setDeviceToken(r.deviceToken);
          diag('app', 'launch verify OK', { userId, prevAgeMs: ageMs });
          // Re-register push token after re-verification in case it
          // rotated or wasn't registered on the first launch.
          void tryRegisterPushToken(r.deviceToken).catch(() => {
            /* best-effort */
          });
        } catch (err) {
          // A failed launch verify means "couldn't refresh attestation
          // right now" — a Vouchflow API hiccup, a network blip, or
          // attestation timing. It does NOT mean the account is
          // invalid. Keep the cached identity and proceed: the cached
          // token is often still server-valid, and the WS auth / next
          // launch re-verify recover on their own. (Previously this
          // wiped all state + reset identity, which booted users to
          // Onboarding on a transient error — see the lunchboxxx
          // incident.) Identity is wiped only by explicit user action.
          diag('app', 'launch verify failed — keeping cached identity', {
            err: String(err),
          });
        }
      }
      void ensureServerBinding({ signalProtocol, vouchflow });
    })();
  }, [hydrated, userId]);

  // Deep-link handler: when the user (or a peer) scans a Speakeasy QR
  // with their phone camera, the OS hands us a `speakeasy://add?handle=…`
  // URL. Route straight to the add-contact flow for that handle so the
  // user can confirm + start the chat without first seeing Home.
  //
  // Handles two cases:
  //   - Cold start: the URL came in via the launching intent. We pull
  //     it off `Linking.getInitialURL()` and navigate once the user is
  //     enrolled (otherwise the navigation target doesn't exist yet).
  //   - Warm: the app is already running; `addEventListener('url')`
  //     fires synchronously when the OS hands us a new URL.
  useEffect(() => {
    if (!hydrated || !userId || !navReady) return;
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
      diag('app', 'deep-link → AddContact', { handle });
      navRef.current?.navigate('AddContact', { handle });
    }
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) handleUrl(url);
    });
    const sub = Linking.addEventListener('url', (ev) => handleUrl(ev.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrated, userId, navReady]);

  // Open WebSocket once enrolled. Close + reset when identity is cleared.
  // Token comes from the identity store (set at signup). On `forceRefresh`
  // — passed by the WS client after a connection failed mid-auth — ask
  // the user before opening Vouchflow/passkey. Realtime can wait for
  // explicit consent; background reconnect loops must not pop biometrics.
  useEffect(() => {
    if (!userId) return;
    if (!deviceToken) {
      diag('app', 'ws connect deferred — device verification required', { userId });
      return;
    }
    diag('app', 'mounting router for userId', { userId });
    const getToken = async (opts?: { forceRefresh?: boolean }) => {
      const cached = useIdentity.getState().deviceToken;
      if (cached && !opts?.forceRefresh) return cached;
      diag('app', 'ws getToken: verification required', {
        reason: opts?.forceRefresh ? 'auth-failed' : 'no-cached-token',
      });
      const r = await verifyDeviceWithExplanation(
        vouchflow,
        opts?.forceRefresh ? 'websocket_auth_failed' : 'missing_token',
      );
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
      try {
        const own = useProfiles.getState().byUserId[userId];
        if (own?.selectedAvatarId) return;
        const dt = getCachedDeviceTokenOrThrow();
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
        send: (frame) => {
          // rc.* diag: confirm call signaling (esp. call_end on hangup)
          // actually leaves the device + the socket is authed when it
          // does. A call_end queued while the WS isn't authed is the
          // suspect for "I hung up but the peer's call stayed up".
          if (typeof frame.type === 'string' && frame.type.startsWith('call_')) {
            diag('call', 'wire send', {
              type: frame.type,
              wsState: ws.getState(),
            });
          }
          ws.enqueueSend(frame);
        },
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
          // Phase 5j Private Call — drop the peer's animation entry
          // when the call ends. Without this the next call to the
          // same peer would briefly render the last frame from the
          // previous call before the new channel delivers anything.
          usePeerAnimation.getState().clear(entry.peerUserId);
        },
        onPeerAnimationFrame: (peerUserId, frame) => {
          // Continuous channels (amplitude / mouthShape / pitchTrend
          // / etc.) update every frame. The event + eventAt fields
          // MUST be sticky: they only change when a new event
          // (frame.event !== 'none') arrives. If we reset eventAt
          // to 0 on every subsequent 'none' frame (~33 ms later,
          // since the sender's cooldown is 60 windows), useEventOverlay
          // would re-run with cleared deps and abort the in-flight
          // ~1.5 s animation about one frame after it started.
          // Holding the previous event + eventAt across 'none'
          // frames lets the animation run to completion; the next
          // real event lands with a fresh `Date.now()` and the
          // hook re-fires.
          _apfCount += 1;
          const _now = Date.now();
          if (_now - _apfLastLog > 2000) {
            diag('anim', 'peer frames', {
              perSec: Math.round(_apfCount / ((_now - _apfLastLog) / 1000)),
              peerUserId,
            });
            _apfCount = 0;
            _apfLastLog = _now;
          }
          const prev = usePeerAnimation.getState().byPeerId[peerUserId];
          // RISING-EDGE detection. The sender now LATCHES each acoustic
          // event across ~9 frames (EventLatch) so the unreliable channel
          // delivers at least one — but that means we see the same 'laugh'
          // on consecutive frames. Treat it as "new" only when it differs
          // from the currently-held event, so the one-shot overlay fires
          // exactly once per beat no matter which of the latched copies
          // arrives first (or how many drop). After the ~1.6s hold expires
          // the held event reverts to 'none', so a genuine second laugh
          // (≥2s later, past the detector cooldown) reads as a rising edge
          // again.
          const isNewEvent =
            frame.event !== 'none' && frame.event !== prev?.event;
          // THROTTLE the store write (and thus the call-screen re-render
          // it triggers) to ~10Hz. The data channel delivers 20Hz, and
          // every write re-renders the avatar + fires JS-driver SVG
          // animations; over a sustained call that saturated the JS
          // thread (frozen face + an unresponsive Hang Up button — the
          // rc.61 report: frames kept arriving at 20/s but the UI was
          // wedged). A NEW acoustic event always applies immediately so
          // a laugh/gasp never gets dropped; the ease in
          // useProsodyAnimatedValues smooths the lower continuous rate.
          const nowMs = Date.now();
          if (!isNewEvent && nowMs - _apfLastApply < 95) return;
          _apfLastApply = nowMs;
          // Hold the last event ONLY for its ~1.6s lifetime, then revert to
          // 'none'. Previously it was held sticky FOREVER across 'none'
          // frames — so a single 'laugh' flipped ExprEyes into its happy
          // squint permanently (until a different event), and on dark-faced
          // animals that squint is an invisible ink arc → the eyes appeared
          // to vanish for the rest of the call (rc.70 on-device report). The
          // one-shot overlay already (re)triggers off `eventAt`, so clearing
          // here doesn't shorten it; it just stops the stale event from
          // pinning continuous-state consumers like the eyes.
          const eventFresh =
            !isNewEvent &&
            !!prev?.eventAt &&
            nowMs - prev.eventAt < EVENT_HOLD_MS;
          usePeerAnimation.getState().set(peerUserId, {
            amplitude: frame.amplitude,
            pitchNorm: frame.pitchNorm,
            zcrNorm: frame.zcrNorm,
            mouthShape: frame.mouthShape,
            pitchTrend: frame.pitchTrend,
            expressiveness: frame.expressiveness,
            activity: frame.activity,
            event: isNewEvent ? frame.event : eventFresh ? prev!.event : 'none',
            // Stamp with the local clock — the overlay's lifetime
            // ticks against receive time, so sender/receiver clock
            // drift doesn't shorten or extend it.
            eventAt: isNewEvent ? Date.now() : eventFresh ? prev!.eventAt : 0,
          });
        },
        getAllowIncomingCalls: () =>
          useSettings.getState().allowIncomingCalls,
        // Phase 5j Private Call — wire the JS shim over the native
        // voice-filter module. wrap installs the DSP into the
        // process-wide holder; dispose clears it on call teardown.
        // The shim itself does the failure-closed gating
        // (isPrivateCallAvailable + FilterError taxonomy); the
        // orchestrator just decides when to call.
        //
        // rc.17+: pass the user's Smoke/Velvet/Glass profile to
        // the native filter so the wrapped voice matches the
        // setting they picked in Account → Voice filter.
        // rc.19+ (Phase 2b): also pass the per-profile formant
        // shift so pitch and vocal-tract size are decoupled.
        voiceFilter: {
          wrap: (callId) => {
            const profileId = useSettings.getState().voiceFilterProfile;
            const semitones = semitonesForProfile(profileId);
            const formantSemitones = formantSemitonesForProfile(profileId);
            return wrapTrackWithFilter(callId, semitones, formantSemitones);
          },
          dispose: () => disposeFilter(),
        },
      });
      setCallOrchestrator(callOrch);
      // Phase 5j PR-G — pipe the native filter's per-window feature
      // events into the orchestrator's animation data channel. No-op
      // when the native module isn't available (test/web). The
      // returned unsubscribe runs on the next CallOrchestrator init
      // cycle (e.g., logout → re-enrollment); the subscription
      // itself is idle while no Private Call is active, so leaking
      // a stale subscription is harmless.
      attachFeatureEventListener(callOrch);
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
      onPeerDeleted: (handle) => {
        // Server told us a direct message we just sent landed on a
        // tombstoned recipient. Surface an in-chat system bubble +
        // freeze the conversation so the user understands and can't
        // keep composing into the void. Both effects are local — no
        // server round-trip; the server already knows.
        if (!userId) return;
        const cid = useConversations.getState().openDirect(userId, handle);
        useConversations.getState().add(cid, {
          id: newMessageId(),
          from: 'system',
          text: `@${handle}'s account was deleted.`,
          kind: 'direct',
          sentAt: Date.now(),
          stage: 'sent',
        });
        useConversations.getState().setFrozen(cid, true);
      },
      // A group member couldn't decrypt our messages (no SenderKey state —
      // they joined after we last distributed, reinstalled, or missed the
      // SKDM) and asked us to re-send it. Re-distribute to just them.
      onSkdmRequest: (from, groupId) =>
        orchestrator.redistributeSenderKey(groupId, from).catch((err) =>
          diag('app', 'redistributeSenderKey failed (non-fatal)', {
            groupId,
            err: String(err),
          }),
        ),
      addToConversation: (conversationId, msg) =>
        useConversations.getState().add(conversationId, msg),
      markDelivered: (msgId) =>
        useConversations.getState().markDelivered(msgId),
      markMessageRead: (msgId, readAt) =>
        useConversations.getState().markMessageRead(msgId, readAt),
      markReadUpTo: (convId, readAt) =>
        useConversations.getState().markReadUpTo(convId, readAt),
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
      // Privacy cover: paint an opaque sheet over the UI whenever the app
      // isn't foregrounded-active, so chat content isn't exposed in the
      // app-switcher thumbnail or during a screen-off→on flash. Cleared
      // on 'active'. (See PrivacyCover — lightweight, no re-auth.)
      useUiState.getState().setPrivacyCovered(next !== 'active');
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
        // rc.10 — flush the diag buffer to AsyncStorage NOW, before
        // the OS gets a chance to kill the process. Without this,
        // anything written to diag in the last 5 seconds (within
        // the throttle window) is lost on a background-kill — which
        // is the exact gap that left bananaman5's call-period
        // events invisible after a presumed crash on rc.6 / rc.8.
        // Best-effort: a failure here doesn't block the rest of the
        // background handler.
        void persistDiagNow();
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
  }, [userId, deviceToken]);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        {!showSplash ? (
          <>
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
            {/* Off-screen — rasterizes peer avatars for notifications. */}
            <AvatarCacheWarmer />
            {/* Off-screen — rasterizes group room-marks for notifications. */}
            <GroupMarkCacheWarmer />
          </>
        ) : (
          <SplashScreen />
        )}
        {/* Opaque privacy sheet — paints over everything while the app is
            backgrounded / inactive / screen-off (driven by the AppState
            listener above). Renders null when foregrounded-active. */}
        <PrivacyCover />
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
 *
 * (v1.0.1-hotfix.2 restored `backgroundColor` after the hotfix.1
 * edge-to-edge attempt was reverted — with the edge-to-edge opt-out back
 * on, the legacy tinted status bar is the correct, supported behavior.)
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
