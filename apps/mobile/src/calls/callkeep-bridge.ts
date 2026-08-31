import { NativeModules, Platform } from 'react-native';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from './orchestrator.js';
import type { ActiveCall } from './types.js';
import { useCalls } from '../store/calls.js';
import {
  nativeCallKitReports,
  type NativeCallKitReport,
  type NativeCallKitReportSource,
} from '../native/callkit.js';

/**
 * Lazy-loaded `react-native-callkeep`. The lib's CommonJS
 * top-level `require` runs Java module-init code that's incompatible
 * with the React Native new architecture — under Fabric, the import
 * itself throws and crashes the app at JS bundle load.
 *
 * `tryLoadCallKeep()` wraps the require in a try/catch + a
 * NativeModules guard, so callers can fall back to no-op when CallKit
 * / ConnectionService isn't available on this build. (Mirrors the
 * pattern in `push/push-notifications.ts` for `@react-native-firebase`.)
 *
 * Crash repro: alpha-0.4.33 — JS exception in `commitHookEffectListMount`
 * traced to the post-enrollment useEffect → CallKeepBridge → static
 * `import RNCallKeep from 'react-native-callkeep'` → throw.
 */
type RNCallKeepShape = {
  setup: (opts: unknown) => Promise<unknown>;
  registerAndroidEvents: () => void;
  setAvailable: (v: boolean) => void;
  addEventListener: (event: string, handler: (arg: any) => void) => void;
  removeEventListener: (event: string) => void;
  getInitialEvents?: () => Promise<Array<{ name: string; data?: any }>>;
  clearInitialEvents?: () => void;
  startCall: (uuid: string, handle: string, name: string, type: string, video: boolean) => void;
  displayIncomingCall: (
    uuid: string,
    handle: string,
    name: string,
    type: string,
    video: boolean,
  ) => void;
  endCall: (uuid: string) => void;
  reportEndCallWithUUID: (uuid: string, reason: number) => void;
  reportConnectedOutgoingCallWithUUID: (uuid: string) => void;
};

function tryLoadCallKeep(): RNCallKeepShape | undefined {
  // The native module name varies by platform — check both before
  // attempting the JS import; if neither is registered the JS-side
  // require would still load (just a JS-only stub) but every call
  // would silently fail at the bridge layer.
  if (!NativeModules.RNCallKeepModule && !NativeModules.RNCallKeep) {
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('react-native-callkeep') as { default?: RNCallKeepShape } | RNCallKeepShape;
    return 'default' in mod && mod.default ? mod.default : (mod as RNCallKeepShape);
  } catch (err) {
    diag('callkeep', 'require failed (fabric incompat?)', { err: String(err) });
    return undefined;
  }
}

/**
 * Lazy-load react-native-webrtc's `RTCAudioSession`, which ships the native
 * CallKit audio-session handshake (WebRTCModule+RTCAudioSession.m →
 * [[RTCAudioSession sharedInstance] audioSessionDidActivate:…]) exposed as
 * `audioSessionDidActivate` / `audioSessionDidDeactivate`. This is the
 * documented react-native-callkeep + react-native-webrtc glue — not bespoke
 * native code. Lazy (a runtime `require`, like tryLoadCallKeep) so importing
 * this bridge in a non-native/test env doesn't pull react-native-webrtc's
 * untransformable source.
 */
type RTCAudioSessionShape = {
  audioSessionDidActivate: () => void;
  audioSessionDidDeactivate: () => void;
};
function tryLoadRTCAudioSession(): RTCAudioSessionShape | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('react-native-webrtc') as { RTCAudioSession?: RTCAudioSessionShape };
    return mod.RTCAudioSession;
  } catch {
    return undefined;
  }
}

/**
 * Bridges the JS `CallOrchestrator` to the platform native call UIs:
 * iOS CallKit and Android ConnectionService, both via
 * `react-native-callkeep`.
 *
 * What this gets us:
 *   - iOS: CallKit ring screen on the lock screen, system audio
 *     ducking, hardware mute key, OS-managed call audio session.
 *   - Android: full-screen ConnectionService UI, disconnect on the
 *     status bar, audio focus interaction with media apps.
 *
 * Privacy: `includesCallsInRecents: false` keeps Speakeasy calls
 * out of iCloud's synced "Recents" history, matching the spec's
 * zero-PII stance. Android ConnectionService has no equivalent
 * cloud sync, so no flag is needed there.
 *
 * PushKit reports killed/background incoming calls natively before the JS
 * runtime exists. This bridge replays those early CallKeep events and binds
 * the native UUID to the encrypted signaling call id once JS is ready.
 */

interface BridgeDeps {
  orchestrator: CallOrchestrator;
  /** Display name shown on the native UI. We use the @handle. */
  appName?: string;
  /** Injectable seams keep the native adoption contract executable in tests. */
  callKeep?: RNCallKeepShape;
  nativeReports?: NativeCallKitReportSource;
  platform?: string;
  incomingFallbackDelayMs?: number;
  orphanCleanupDelayMs?: number;
}

const IOS_NATIVE_REPORT_GRACE_MS = 1_500;
const IOS_ORPHAN_CLEANUP_MS = 30_000;
const CALL_LIFECYCLE_TOMBSTONE_MS = 60_000;
const rejectedCallTombstones = new Map<string, number>();

function markRejectedCall(callId: string): void {
  const now = Date.now();
  rejectedCallTombstones.set(callId, now + CALL_LIFECYCLE_TOMBSTONE_MS);
  for (const [id, expiresAt] of rejectedCallTombstones) {
    if (expiresAt <= now) rejectedCallTombstones.delete(id);
  }
}

function isRejectedCall(callId: string): boolean {
  const expiresAt = rejectedCallTombstones.get(callId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    rejectedCallTombstones.delete(callId);
    return false;
  }
  return true;
}

export class CallKeepBridge {
  private setupDone = false;
  private lifecycleGeneration = 0;
  private unsubscribeStore?: () => void;
  private unsubscribeNativeReports?: () => void;
  private nativeReportSource?: NativeCallKitReportSource;
  private readonly nativeRecoveryInFlight = new Set<string>();
  private readonly incomingFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Map our internal `call-{ulid}` ids ↔ CallKit's UUID-shaped ids. */
  private readonly idToUuid = new Map<string, string>();
  private readonly uuidToId = new Map<string, string>();
  /** UUIDs already reported natively by AppDelegate's PushKit callback. */
  private readonly nativeReportedUuids = new Set<string>();
  private readonly nativeHandoffUuids = new Set<string>();
  private readonly failedNativeUuids = new Map<string, string>();
  private readonly fallbackCallIds = new Map<string, string>();
  private readonly releasedFallbackCallIds = new Set<string>();
  private readonly acknowledgedNativeUuids = new Set<string>();
  /** CallKit actions can arrive before the encrypted offer has reached JS. */
  private readonly pendingActions = new Map<string, 'answer' | 'end'>();
  /** Resolved on first start(); `undefined` when the native module
   * isn't available on this build (e.g. new-arch Android with the
   * pre-Fabric callkeep lib). All methods then no-op. */
  private rnCallKeep: RNCallKeepShape | undefined;

  constructor(private readonly deps: BridgeDeps) {}

  async start(): Promise<void> {
    if (this.setupDone) return;
    const generation = ++this.lifecycleGeneration;
    const RNCallKeep = this.deps.callKeep ?? tryLoadCallKeep();
    if (!RNCallKeep) {
      diag('callkeep', 'native module unavailable — bridge no-ops');
      if (generation === this.lifecycleGeneration) this.attachStoreSubscriber();
      this.setupDone = true;
      return;
    }
    this.rnCallKeep = RNCallKeep;
    try {
      await RNCallKeep.setup({
        ios: {
          appName: this.deps.appName ?? 'Speakeasy',
          // Spec §1: zero PII. Don't surface our calls in the
          // device's iCloud-synced Recents list.
          includesCallsInRecents: false,
          // We DO support video calls — reporting the call as video to
          // CallKit is what gives iOS the video-call context (and keeps
          // the app alive in the background so the remote feed can float
          // into a PiP bubble). The per-call `video` flag in startCall /
          // displayIncomingCall below is what actually marks each call.
          supportsVideo: true,
          maximumCallGroups: '1',
          maximumCallsPerCallGroup: '1',
        },
        android: {
          // alertTitle / alertDescription / cancelButton / okButton
          // intentionally omitted. When passed, CallKeep raises a
          // blocking system dialog the first time setup runs, asking
          // the user to enable Speakeasy as a "calling app" in system
          // settings. That's a poor moment to interrupt — the user
          // just finished enrollment — and it broke Tier B Maestro
          // by covering `conversations-userid` with the permission
          // dialog. Without these fields CallKeep silently registers
          // its phone-account; if the OS hasn't granted the calling-
          // app role, the lock-screen ringer degrades to the in-app
          // IncomingCallScreen (same fallback as 0.4.34's lazy load).
          // Real-device users who want the system ringer can grant
          // it manually via Settings → Apps → Default apps → Calling
          // app; we'll surface that as a Settings affordance later.
          additionalPermissions: [],
          // Foreground service is auto-managed by CallKeep on Android
          // when this is set — we get a system call notification while
          // a call is active so the OS doesn't kill our process.
          foregroundService: {
            channelId: 'xyz.speakeasyapp.app.calls',
            channelName: 'Active calls',
            notificationTitle: 'Speakeasy call in progress',
            // react-native-callkeep resolves this via
            // `R.drawable.<name>` only (not mipmap). `ic_launcher` is a
            // mipmap and the lookup failed → foreground-service start
            // crashed at enrollment time, the alpha-0.4.20 repro. Using
            // a dedicated single-color vector drawable that lives in
            // `res/drawable/`.
            notificationIcon: 'ic_call_notification',
          },
        },
      });
      if (generation !== this.lifecycleGeneration) return;
      if (Platform.OS === 'android') {
        RNCallKeep.registerAndroidEvents();
        RNCallKeep.setAvailable(true);
      }
      if (Platform.OS === 'ios') {
        // Manual-audio mode for CallKit coexistence (see the
        // WebRTCModule+RTCAudioSession patch). WebRTC must NOT auto-grab the
        // AVAudioSession — CallKit owns it and drives isAudioEnabled via the
        // didActivate/didDeactivate handlers below. Set once here, before the
        // first call's audio unit initialises. Without this, WebRTC and CallKit
        // fight over the session and audio is one-way / silent.
        try {
          const wm = NativeModules.WebRTCModule as
            | { setManualAudio?: (manual: boolean) => void }
            | undefined;
          wm?.setManualAudio?.(true);
          diag('callkeep', 'manual audio enabled');
        } catch (err) {
          diag('callkeep', 'setManualAudio failed', { err: String(err) });
        }
      }
      this.attachListeners();
      await this.attachNativeReportHandoff(generation);
      if (generation !== this.lifecycleGeneration) return;
      await this.replayInitialEvents(generation);
      if (generation !== this.lifecycleGeneration) return;
      this.attachStoreSubscriber();
      this.setupDone = true;
      diag('callkeep', 'setup ok');
    } catch (err) {
      diag('callkeep', 'setup failed (non-fatal)', { err: String(err) });
      if (generation !== this.lifecycleGeneration) return;
      this.rnCallKeep = undefined;
      this.attachStoreSubscriber();
      this.setupDone = true;
    }
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    const ownedUuids = new Map([...this.idToUuid].map(([callId, uuid]) => [uuid, callId]));
    for (const [uuid, callId] of this.failedNativeUuids) ownedUuids.set(uuid, callId);
    for (const [uuid, callId] of ownedUuids) {
      try {
        this.rnCallKeep?.reportEndCallWithUUID(uuid, 2);
        diag('callkeep', 'CallKit end reported', { callUUID: uuid });
      } catch (err) {
        diag('callkeep', 'CallKit end report failed', { err: String(err) });
      }
      if (this.nativeHandoffUuids.has(uuid) || this.failedNativeUuids.has(uuid)) {
        this.acknowledgeNativeReport(uuid);
      }
      this.idToUuid.delete(callId);
      this.uuidToId.delete(uuid);
      this.nativeReportedUuids.delete(uuid);
      this.nativeHandoffUuids.delete(uuid);
      this.failedNativeUuids.delete(uuid);
      this.pendingActions.delete(uuid);
    }
    this.idToUuid.clear();
    this.uuidToId.clear();
    this.nativeReportedUuids.clear();
    this.nativeHandoffUuids.clear();
    this.failedNativeUuids.clear();
    this.pendingActions.clear();
    this.rnCallKeep?.removeEventListener('answerCall');
    this.rnCallKeep?.removeEventListener('endCall');
    this.rnCallKeep?.removeEventListener('didPerformSetMutedCallAction');
    this.rnCallKeep?.removeEventListener('didDisplayIncomingCall');
    this.rnCallKeep?.removeEventListener('didLoadWithEvents');
    this.rnCallKeep?.removeEventListener('didActivateAudioSession');
    this.rnCallKeep?.removeEventListener('didDeactivateAudioSession');
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.unsubscribeNativeReports?.();
    this.unsubscribeNativeReports = undefined;
    for (const timer of this.incomingFallbackTimers.values()) clearTimeout(timer);
    this.incomingFallbackTimers.clear();
    for (const timer of this.orphanCleanupTimers.values()) clearTimeout(timer);
    this.orphanCleanupTimers.clear();
    this.nativeRecoveryInFlight.clear();
    this.fallbackCallIds.clear();
    this.releasedFallbackCallIds.clear();
    this.setupDone = false;
  }

  rejectIncomingCall(callId: string): void {
    markRejectedCall(callId);
    this.cancelIncomingFallback(callId);
    const mappedUuid = this.idToUuid.get(callId);
    const failedUuid = [...this.failedNativeUuids].find(([, id]) => id === callId)?.[0];
    const uuids = new Set([mappedUuid, failedUuid].filter((uuid): uuid is string => !!uuid));
    if (uuids.size === 0) return;
    for (const uuid of uuids) this.endOrphan(uuid, 'signaling rejected incoming call');
  }

  private async attachNativeReportHandoff(generation: number): Promise<void> {
    if (this.platform() !== 'ios') return;
    const source = this.deps.nativeReports ?? nativeCallKitReports;
    this.nativeReportSource = source;
    this.unsubscribeNativeReports = source.subscribe((report) => {
      if (generation === this.lifecycleGeneration) this.applyNativeReport(report);
    });
    try {
      const reports = await source.drain();
      if (generation === this.lifecycleGeneration) this.applyDrainedNativeReports(reports);
    } catch (err) {
      diag('callkeep', 'native CallKit handoff drain failed', { err: String(err) });
    }
  }

  private attachListeners(): void {
    if (!this.rnCallKeep) return;
    this.rnCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      this.handleCallAction('answer', callUUID);
    });
    this.rnCallKeep.addEventListener('endCall', ({ callUUID }) => {
      this.handleCallAction('end', callUUID);
    });
    this.rnCallKeep.addEventListener('didDisplayIncomingCall', (data) => {
      diag('callkeep', 'didDisplayIncomingCall', {
        hasCallUUID: !!normalizeUuid(data?.callUUID),
        fromPushKit: !!data?.fromPushKit,
        hasError: !!data?.error,
      });
      this.handleDisplayedIncomingCall(data);
    });
    this.rnCallKeep.addEventListener('didLoadWithEvents', (events) => {
      this.processInitialEvents(Array.isArray(events) ? events : []);
    });
    this.rnCallKeep.addEventListener('didPerformSetMutedCallAction', ({ muted }) => {
      diag('callkeep', 'mute toggle', { muted: !!muted });
      this.deps.orchestrator.setMicMuted(!!muted);
    });
    // iOS CallKit audio-session handshake. CallKit owns the AVAudioSession;
    // when it activates/deactivates it, WebRTC must be told so its ADM uses
    // the right session — otherwise audio is silent / one-way. This is the
    // exact glue documented by react-native-callkeep + react-native-webrtc.
    this.rnCallKeep.addEventListener('didActivateAudioSession', () => {
      diag('callkeep', 'didActivateAudioSession');
      try {
        tryLoadRTCAudioSession()?.audioSessionDidActivate();
      } catch (err) {
        diag('callkeep', 'audioSessionDidActivate failed', { err: String(err) });
      }
    });
    this.rnCallKeep.addEventListener('didDeactivateAudioSession', () => {
      diag('callkeep', 'didDeactivateAudioSession');
      try {
        tryLoadRTCAudioSession()?.audioSessionDidDeactivate();
      } catch (err) {
        diag('callkeep', 'audioSessionDidDeactivate failed', { err: String(err) });
      }
    });
  }

  private async replayInitialEvents(generation: number): Promise<void> {
    const RNCallKeep = this.rnCallKeep;
    if (!RNCallKeep?.getInitialEvents) return;
    try {
      const events = await RNCallKeep.getInitialEvents();
      if (generation !== this.lifecycleGeneration) return;
      this.processInitialEvents(Array.isArray(events) ? events : []);
      RNCallKeep.clearInitialEvents?.();
    } catch (err) {
      diag('callkeep', 'initial event replay failed', { err: String(err) });
    }
  }

  private processInitialEvents(events: Array<{ name: string; data?: any }>): void {
    // Bind UUIDs first even when answer/end appears earlier in the array.
    for (const event of events) {
      if (event.name === 'RNCallKeepDidDisplayIncomingCall') {
        this.handleDisplayedIncomingCall(event.data);
      }
    }
    for (const event of events) {
      if (event.name === 'RNCallKeepPerformAnswerCallAction') {
        this.handleCallAction('answer', event.data?.callUUID);
      } else if (event.name === 'RNCallKeepPerformEndCallAction') {
        this.handleCallAction('end', event.data?.callUUID);
      }
    }
  }

  private handleDisplayedIncomingCall(data: any): void {
    const payload = data?.payload as { call_id?: unknown; call_uuid?: unknown } | undefined;
    const rawUuid = data?.callUUID ?? payload?.call_uuid;
    const uuid = normalizeUuid(rawUuid);
    if (!isPushKit(data?.fromPushKit)) {
      const fallbackCallId = uuid ? this.fallbackCallIds.get(uuid) : undefined;
      if (!uuid || !fallbackCallId) return;
      this.fallbackCallIds.delete(uuid);
      if (this.displayFailed(data?.error, data?.errorCode)) {
        if (this.idToUuid.get(fallbackCallId) === uuid) this.idToUuid.delete(fallbackCallId);
        this.uuidToId.delete(uuid);
        this.releaseIncomingFallback(fallbackCallId, data?.errorCode ?? data?.error);
      }
      return;
    }
    const payloadCallId = typeof payload?.call_id === 'string' ? payload.call_id : undefined;
    const callId = payloadCallId ?? (uuid ? this.uuidToId.get(uuid) : undefined);
    if (!callId || !uuid) {
      diag('callkeep', 'PushKit call missing mapping', {
        hasCallId: !!callId,
        hasUuid: !!uuid,
      });
      if (uuid) this.recoverDisplayedCall(uuid, data?.error, data?.errorCode);
      return;
    }
    const authoritativeUuid = this.idToUuid.get(callId);
    if (authoritativeUuid && authoritativeUuid !== uuid) {
      diag('callkeep', 'stale CallKit display callback ignored', {
        callId,
        callUUID: uuid,
        authoritativeUUID: authoritativeUuid,
      });
      return;
    }
    if (!authoritativeUuid) {
      this.recoverDisplayedCall(uuid, data?.error, data?.errorCode);
      return;
    }
    this.settleNativeDisplay(callId, uuid, data?.error, data?.errorCode);
  }

  private bindNativeReport(report: NativeCallKitReport): void {
    const callId = report.callId;
    const uuid = normalizeUuid(report.callUUID);
    if (!callId || !uuid) return;

    // A call id must own exactly one CallKit UUID. If a legacy/random sibling
    // exists, report it ended before adopting the native PushKit UUID so an
    // answer can never cause the sibling to resolve as a decline.
    const siblingUuid = this.idToUuid.get(callId);
    if (siblingUuid && siblingUuid !== uuid) {
      this.endOrphan(siblingUuid, 'superseded by native PushKit mapping');
    }
    const siblingCallId = this.uuidToId.get(uuid);
    if (siblingCallId && siblingCallId !== callId) {
      this.idToUuid.delete(siblingCallId);
    }

    this.idToUuid.set(callId, uuid);
    this.uuidToId.set(uuid, callId);
    this.nativeHandoffUuids.add(uuid);
    diag('callkeep', 'PushKit call mapped', { callId, callUUID: uuid });
    if (isRejectedCall(callId)) {
      this.endOrphan(uuid, 'signaling rejected incoming call');
      return;
    }
    this.scheduleOrphanCleanup(report);
    this.acknowledgeActiveNativeReports(callId);
    this.applyPendingAction(callId, uuid);
  }

  private settleNativeDisplay(
    callId: string,
    uuid: string,
    error: unknown,
    errorCode?: unknown,
  ): void {
    if (this.idToUuid.get(callId) !== uuid) return;
    if (errorCode === 'CallUUIDAlreadyExists') {
      this.failedNativeUuids.delete(uuid);
      this.nativeReportedUuids.add(uuid);
      this.cancelIncomingFallback(callId);
      diag('callkeep', 'duplicate native CallKit report confirmed', { callId, callUUID: uuid });
      return;
    }
    if (this.displayFailed(error, errorCode)) {
      this.nativeReportedUuids.delete(uuid);
      this.failedNativeUuids.set(uuid, callId);
      this.nativeHandoffUuids.delete(uuid);
      this.idToUuid.delete(callId);
      this.uuidToId.delete(uuid);
      diag('callkeep', 'native CallKit report failed', { callId, callUUID: uuid, error });
      this.acknowledgeNativeReport(uuid);
      const active = this.deps.orchestrator.getActive();
      if (active?.callId === callId && active.stage === 'incoming_ringing') {
        this.scheduleIncomingFallback(active);
      }
      return;
    }
    this.failedNativeUuids.delete(uuid);
    this.nativeReportedUuids.add(uuid);
    this.cancelIncomingFallback(callId);
    diag('callkeep', 'native CallKit report confirmed', { callId, callUUID: uuid });
  }

  private recoverDisplayedCall(uuid: string, error: unknown, errorCode?: unknown): void {
    if (this.nativeRecoveryInFlight.has(uuid)) return;
    this.nativeRecoveryInFlight.add(uuid);
    const generation = this.lifecycleGeneration;
    const source = this.nativeReportSource ?? this.deps.nativeReports ?? nativeCallKitReports;
    void source
      .drain()
      .then((reports) => {
        if (generation !== this.lifecycleGeneration) return;
        this.applyDrainedNativeReports(reports);
        const callId = this.uuidToId.get(uuid);
        if (callId) this.settleNativeDisplay(callId, uuid, error, errorCode);
        else this.endOrphan(uuid, 'PushKit report missing authoritative mapping');
      })
      .catch((err) => {
        if (generation !== this.lifecycleGeneration) return;
        diag('callkeep', 'native CallKit mapping recovery failed', {
          callUUID: uuid,
          err: String(err),
        });
        this.endOrphan(uuid, 'PushKit report mapping recovery failed');
      })
      .finally(() => this.nativeRecoveryInFlight.delete(uuid));
  }

  private handleCallAction(action: 'answer' | 'end', rawUuid: unknown): void {
    const uuid = normalizeUuid(rawUuid);
    const callId = uuid ? this.uuidToId.get(uuid) : undefined;
    diag('callkeep', `${action}Call`, { callUUID: uuid, callId });
    if (!uuid) return;
    if (!callId) {
      this.pendingActions.set(uuid, action);
      this.recoverMappingOrEnd(uuid, `${action} action missing call_id mapping`);
      return;
    }
    if (this.deps.orchestrator.getActive()?.callId !== callId) {
      this.pendingActions.set(uuid, action);
      return;
    }
    if (this.nativeHandoffUuids.has(uuid) && !this.failedNativeUuids.has(uuid)) {
      this.settleNativeDisplay(callId, uuid, undefined, undefined);
    }
    this.performCallAction(action);
  }

  private applyPendingAction(callId: string, uuid: string): void {
    if (this.deps.orchestrator.getActive()?.callId !== callId) return;
    const action = this.pendingActions.get(uuid);
    if (!action) return;
    this.pendingActions.delete(uuid);
    if (this.nativeHandoffUuids.has(uuid) && !this.failedNativeUuids.has(uuid)) {
      this.settleNativeDisplay(callId, uuid, undefined, undefined);
    }
    this.performCallAction(action);
  }

  private performCallAction(action: 'answer' | 'end'): void {
    if (action === 'answer') {
      void this.deps.orchestrator.accept().catch((err) => {
        diag('callkeep', 'accept failed', { err: String(err) });
      });
      return;
    }
    const active = this.deps.orchestrator.getActive();
    if (active?.stage === 'incoming_ringing') this.deps.orchestrator.decline();
    else this.deps.orchestrator.hangup();
  }

  private endOrphan(uuid: string, reason: string): void {
    try {
      // FAILED is react-native-callkeep END_CALL_REASONS.FAILED. Reporting the
      // end directly avoids emitting a synthetic endCall action into JS.
      this.rnCallKeep?.reportEndCallWithUUID(uuid, 1);
      diag('callkeep', 'orphan CallKit call ended', { callUUID: uuid, reason });
    } catch (err) {
      diag('callkeep', 'orphan CallKit cleanup failed', {
        callUUID: uuid,
        reason,
        err: String(err),
      });
    }
    this.acknowledgeNativeReport(uuid);
    const callId = this.uuidToId.get(uuid);
    if (callId && this.idToUuid.get(callId) === uuid) this.idToUuid.delete(callId);
    this.uuidToId.delete(uuid);
    this.fallbackCallIds.delete(uuid);
    if (callId) this.releasedFallbackCallIds.delete(callId);
    this.nativeReportedUuids.delete(uuid);
    this.nativeHandoffUuids.delete(uuid);
    this.failedNativeUuids.delete(uuid);
    this.pendingActions.delete(uuid);
  }

  private recoverMappingOrEnd(uuid: string, reason: string): void {
    if (this.nativeRecoveryInFlight.has(uuid)) return;
    this.nativeRecoveryInFlight.add(uuid);
    const generation = this.lifecycleGeneration;
    const source = this.nativeReportSource ?? this.deps.nativeReports ?? nativeCallKitReports;
    void source
      .drain()
      .then((reports) => {
        if (generation !== this.lifecycleGeneration) return;
        const ended = this.applyDrainedNativeReports(reports);
        if (!this.uuidToId.has(uuid) && !ended.has(uuid)) this.endOrphan(uuid, reason);
      })
      .catch((err) => {
        if (generation !== this.lifecycleGeneration) return;
        diag('callkeep', 'native CallKit mapping recovery failed', {
          callUUID: uuid,
          err: String(err),
        });
        this.endOrphan(uuid, reason);
      })
      .finally(() => this.nativeRecoveryInFlight.delete(uuid));
  }

  private applyDrainedNativeReports(reports: NativeCallKitReport[]): Set<string> {
    const ended = new Set<string>();
    for (const report of reports) {
      const uuid = normalizeUuid(report.callUUID);
      if (report.expired) {
        if (uuid) {
          this.endOrphan(uuid, 'stale native CallKit mapping');
          ended.add(uuid);
        }
      } else {
        this.bindNativeReport(report);
      }
    }
    return ended;
  }

  private applyNativeReport(report: NativeCallKitReport): void {
    const uuid = normalizeUuid(report.callUUID);
    if (uuid) this.acknowledgedNativeUuids.delete(uuid);
    if (report.expired) {
      if (uuid) this.endOrphan(uuid, 'stale native CallKit mapping');
      return;
    }
    this.bindNativeReport(report);
  }

  private scheduleOrphanCleanup(report: NativeCallKitReport): void {
    const uuid = normalizeUuid(report.callUUID);
    if (!uuid || this.orphanCleanupTimers.has(uuid) || this.acknowledgedNativeUuids.has(uuid)) {
      return;
    }
    const maxDelay = this.deps.orphanCleanupDelayMs ?? IOS_ORPHAN_CLEANUP_MS;
    const age =
      report.reportedAtMs === undefined ? 0 : Math.max(0, Date.now() - report.reportedAtMs);
    const timer = setTimeout(
      () => {
        this.orphanCleanupTimers.delete(uuid);
        const callId = this.uuidToId.get(uuid) ?? this.failedNativeUuids.get(uuid);
        if (callId && this.deps.orchestrator.getActive()?.callId === callId) {
          this.acknowledgeNativeReport(uuid);
        } else if (this.failedNativeUuids.has(uuid)) {
          this.acknowledgeNativeReport(uuid);
          this.failedNativeUuids.delete(uuid);
          this.nativeHandoffUuids.delete(uuid);
        } else {
          this.endOrphan(uuid, 'native CallKit report never matched signaling');
        }
      },
      Math.max(0, maxDelay - age),
    );
    this.orphanCleanupTimers.set(uuid, timer);
  }

  private acknowledgeActiveNativeReports(callId: string): void {
    if (this.deps.orchestrator.getActive()?.callId !== callId) return;
    const mappedUuid = this.idToUuid.get(callId);
    if (mappedUuid && this.nativeHandoffUuids.has(mappedUuid)) {
      this.acknowledgeNativeReport(mappedUuid);
    }
    for (const [uuid, failedCallId] of this.failedNativeUuids) {
      if (failedCallId === callId) {
        this.acknowledgeNativeReport(uuid);
      }
    }
  }

  private acknowledgeNativeReport(uuid: string): void {
    if (this.acknowledgedNativeUuids.has(uuid)) return;
    this.acknowledgedNativeUuids.add(uuid);
    const timer = this.orphanCleanupTimers.get(uuid);
    if (timer) clearTimeout(timer);
    this.orphanCleanupTimers.delete(uuid);
    const source = this.nativeReportSource ?? this.deps.nativeReports ?? nativeCallKitReports;
    source.acknowledge(uuid);
  }

  private scheduleIncomingFallback(call: ActiveCall): void {
    const mappedUuid = this.idToUuid.get(call.callId);
    if (
      this.incomingFallbackTimers.has(call.callId) ||
      (mappedUuid !== undefined && this.nativeReportedUuids.has(mappedUuid))
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.incomingFallbackTimers.delete(call.callId);
      const active = this.deps.orchestrator.getActive();
      if (!active || active.callId !== call.callId || active.stage !== 'incoming_ringing') {
        return;
      }
      const tentativeUuid = this.idToUuid.get(call.callId);
      if (tentativeUuid && this.nativeReportedUuids.has(tentativeUuid)) return;
      const failedUuid = [...this.failedNativeUuids].find(([, id]) => id === call.callId)?.[0];
      if (!failedUuid) {
        this.releaseIncomingFallback(call.callId, 'native CallKit report not confirmed');
        return;
      }
      const uuid = failedUuid;
      this.idToUuid.set(call.callId, uuid);
      this.uuidToId.set(uuid, call.callId);
      this.fallbackCallIds.set(uuid, call.callId);
      try {
        this.rnCallKeep?.displayIncomingCall(
          uuid,
          active.peerUserId,
          `@${active.peerUserId}`,
          'generic',
          active.kind === 'video',
        );
        diag('callkeep', 'displayIncomingCall requested: native report fallback', {
          callUUID: uuid,
          isVideo: active.kind === 'video',
        });
      } catch (err) {
        this.fallbackCallIds.delete(uuid);
        if (this.idToUuid.get(call.callId) === uuid) this.idToUuid.delete(call.callId);
        this.uuidToId.delete(uuid);
        diag('callkeep', 'displayIncomingCall fallback failed', { err: String(err) });
        this.releaseIncomingFallback(call.callId, err);
      }
    }, this.deps.incomingFallbackDelayMs ?? IOS_NATIVE_REPORT_GRACE_MS);
    this.incomingFallbackTimers.set(call.callId, timer);
  }

  private cancelIncomingFallback(callId: string): void {
    const timer = this.incomingFallbackTimers.get(callId);
    if (timer) clearTimeout(timer);
    this.incomingFallbackTimers.delete(callId);
  }

  private releaseIncomingFallback(callId: string, error: unknown): void {
    if (this.releasedFallbackCallIds.has(callId)) return;
    const active = this.deps.orchestrator.getActive();
    if (active?.callId !== callId || active.stage !== 'incoming_ringing') return;
    this.releasedFallbackCallIds.add(callId);
    diag('callkeep', 'system incoming-call UI unavailable', { callId, error: String(error) });
    this.deps.orchestrator.showIncomingCallFallback(callId);
  }

  private displayFailed(error: unknown, errorCode: unknown): boolean {
    if (errorCode === 'CallUUIDAlreadyExists') return false;
    return (
      (typeof error === 'string' ? error.length > 0 : error != null) ||
      (typeof errorCode === 'string' && errorCode.length > 0)
    );
  }

  /**
   * Mirror orchestrator state into CallKit/ConnectionService.
   * - `outgoing_ringing` → `startCall` (registers with the system)
   * - `incoming_ringing` → `displayIncomingCall` (system ring UI)
   * - `connected`        → `reportConnected`
   * - `ended`            → `endCall` (dismiss native UI)
   */
  private attachStoreSubscriber(): void {
    let prev = useCalls.getState().active;
    this.diff(undefined, prev);
    this.unsubscribeStore = useCalls.subscribe((s) => {
      const next = s.active;
      const previous = prev;
      prev = next;
      this.diff(previous, next);
    });
  }

  private diff(prev: ActiveCall | undefined, next: ActiveCall | undefined): void {
    const RNCallKeep = this.rnCallKeep;
    if (!RNCallKeep) {
      if (!prev && next?.stage === 'incoming_ringing' && !next.isCaller) {
        this.scheduleIncomingFallback(next);
      } else if (!next && prev) {
        this.cancelIncomingFallback(prev.callId);
      }
      return;
    }
    if (!prev && next) {
      if (!next.isCaller && this.platform() === 'ios') {
        this.acknowledgeActiveNativeReports(next.callId);
      }
      const uuid =
        !next.isCaller && this.platform() === 'ios'
          ? this.idToUuid.get(next.callId)
          : this.allocUuid(next.callId);
      // Report the actual media kind so CallKit treats a video call as a
      // video call — required for the iOS background video-call context
      // that Picture-in-Picture relies on (bug #4).
      const isVideo = next.kind === 'video';
      if (next.isCaller) {
        if (!uuid) return;
        try {
          RNCallKeep.startCall(uuid, next.peerUserId, `@${next.peerUserId}`, 'generic', isVideo);
          diag('callkeep', 'startCall requested', { callUUID: uuid, isVideo });
        } catch (err) {
          diag('callkeep', 'startCall failed', { err: String(err) });
        }
      } else if (next.stage === 'incoming_ringing') {
        if (this.platform() === 'ios') {
          if (uuid && this.nativeReportedUuids.has(uuid)) {
            diag('callkeep', 'displayIncomingCall skipped: adopting native PushKit report', {
              callUUID: uuid,
              isVideo,
            });
          } else {
            this.scheduleIncomingFallback(next);
            diag('callkeep', 'awaiting native PushKit report before incoming-call fallback', {
              isVideo,
            });
          }
        } else if (uuid && !this.nativeReportedUuids.has(uuid)) {
          try {
            RNCallKeep.displayIncomingCall(
              uuid,
              next.peerUserId,
              `@${next.peerUserId}`,
              'generic',
              isVideo,
            );
            diag('callkeep', 'displayIncomingCall requested', { callUUID: uuid, isVideo });
          } catch (err) {
            diag('callkeep', 'displayIncomingCall failed', { err: String(err) });
          }
        } else if (uuid) {
          diag('callkeep', 'displayIncomingCall skipped: already reported by PushKit', {
            callUUID: uuid,
            isVideo,
          });
        }
      }
      if (uuid) this.applyPendingAction(next.callId, uuid);
      return;
    }
    if (!next) {
      if (prev) {
        this.cancelIncomingFallback(prev.callId);
        const uuid = this.idToUuid.get(prev.callId);
        if (uuid) {
          const nativeOwned = this.nativeHandoffUuids.has(uuid) || this.failedNativeUuids.has(uuid);
          try {
            RNCallKeep.reportEndCallWithUUID(uuid, 2);
            diag('callkeep', 'CallKit end reported', { callUUID: uuid });
          } catch (err) {
            diag('callkeep', 'CallKit end report failed', { err: String(err) });
          }
          this.idToUuid.delete(prev.callId);
          this.uuidToId.delete(uuid);
          this.fallbackCallIds.delete(uuid);
          this.releasedFallbackCallIds.delete(prev.callId);
          this.nativeReportedUuids.delete(uuid);
          this.nativeHandoffUuids.delete(uuid);
          this.pendingActions.delete(uuid);
          if (nativeOwned) this.acknowledgeNativeReport(uuid);
        }
      }
      return;
    }
    if (prev && prev.stage !== 'connected' && next.stage === 'connected') {
      const uuid = this.idToUuid.get(next.callId);
      if (uuid) {
        try {
          RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
          diag('callkeep', 'reportConnected requested', { callUUID: uuid });
        } catch (err) {
          diag('callkeep', 'reportConnected failed', { err: String(err) });
        }
      }
    }
  }

  private allocUuid(callId: string): string {
    let uuid = this.idToUuid.get(callId);
    if (!uuid) {
      uuid = uuidV4();
      this.idToUuid.set(callId, uuid);
      this.uuidToId.set(uuid, callId);
    }
    return uuid;
  }

  private platform(): string {
    return this.deps.platform ?? Platform.OS;
  }
}

/**
 * Tiny UUID v4. CallKit/ConnectionService want UUID-shaped strings;
 * we don't need cryptographic randomness here (the call ID itself is
 * already randomized via `newCallId()`), just shape compliance.
 */
function uuidV4(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) {
    if (i === 12) {
      s += '4'; // version
    } else if (i === 16) {
      s += hex[8 + Math.floor(Math.random() * 4)]; // variant 8/9/a/b
    } else {
      s += hex[Math.floor(Math.random() * 16)];
    }
    if (i === 7 || i === 11 || i === 15 || i === 19) s += '-';
  }
  return s;
}

function normalizeUuid(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : undefined;
}

function isPushKit(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
