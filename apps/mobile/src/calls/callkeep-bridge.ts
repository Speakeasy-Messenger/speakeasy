import { NativeModules, Platform } from 'react-native';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from './orchestrator.js';
import type { ActiveCall } from './types.js';
import { useCalls } from '../store/calls.js';

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
  addEventListener: (event: string, handler: (arg: { callUUID: string; muted?: boolean }) => void) => void;
  removeEventListener: (event: string) => void;
  startCall: (uuid: string, handle: string, name: string, type: string, video: boolean) => void;
  displayIncomingCall: (uuid: string, handle: string, name: string, type: string, video: boolean) => void;
  endCall: (uuid: string) => void;
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
    return ('default' in mod && mod.default) ? mod.default : (mod as RNCallKeepShape);
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
 * What this is NOT yet:
 *   - PushKit-driven background ringing on iOS (requires a VoIP push
 *     certificate + a separate push payload schema). Without it,
 *     CallKit only fires while the app is foreground or in a brief
 *     wake window. Phase 6.5 work; flagged in the integration notes.
 */

interface BridgeDeps {
  orchestrator: CallOrchestrator;
  /** Display name shown on the native UI. We use the @handle. */
  appName?: string;
}

export class CallKeepBridge {
  private setupDone = false;
  private unsubscribeStore?: () => void;
  /** Map our internal `call-{ulid}` ids ↔ CallKit's UUID-shaped ids. */
  private readonly idToUuid = new Map<string, string>();
  private readonly uuidToId = new Map<string, string>();
  /** Resolved on first start(); `undefined` when the native module
   * isn't available on this build (e.g. new-arch Android with the
   * pre-Fabric callkeep lib). All methods then no-op. */
  private rnCallKeep: RNCallKeepShape | undefined;

  constructor(private readonly deps: BridgeDeps) {}

  async start(): Promise<void> {
    if (this.setupDone) return;
    const RNCallKeep = tryLoadCallKeep();
    if (!RNCallKeep) {
      diag('callkeep', 'native module unavailable — bridge no-ops');
      this.setupDone = true; // mark so we don't retry every call
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
      this.attachStoreSubscriber();
      this.setupDone = true;
      diag('callkeep', 'setup ok');
    } catch (err) {
      diag('callkeep', 'setup failed (non-fatal)', { err: String(err) });
    }
  }

  stop(): void {
    if (!this.setupDone || !this.rnCallKeep) return;
    this.rnCallKeep.removeEventListener('answerCall');
    this.rnCallKeep.removeEventListener('endCall');
    this.rnCallKeep.removeEventListener('didPerformSetMutedCallAction');
    this.rnCallKeep.removeEventListener('didActivateAudioSession');
    this.rnCallKeep.removeEventListener('didDeactivateAudioSession');
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.setupDone = false;
  }

  private attachListeners(): void {
    if (!this.rnCallKeep) return;
    this.rnCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      const callId = this.uuidToId.get(callUUID);
      diag('callkeep', 'answerCall', { callUUID, callId });
      if (!callId) return;
      void this.deps.orchestrator.accept().catch((err) => {
        diag('callkeep', 'accept failed', { err: String(err) });
      });
    });
    this.rnCallKeep.addEventListener('endCall', ({ callUUID }) => {
      const callId = this.uuidToId.get(callUUID);
      diag('callkeep', 'endCall', { callUUID, callId });
      if (!callId) return;
      const active = this.deps.orchestrator.getActive();
      if (active?.stage === 'incoming_ringing') {
        this.deps.orchestrator.decline();
      } else {
        this.deps.orchestrator.hangup();
      }
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

  /**
   * Mirror orchestrator state into CallKit/ConnectionService.
   * - `outgoing_ringing` → `startCall` (registers with the system)
   * - `incoming_ringing` → `displayIncomingCall` (system ring UI)
   * - `connected`        → `reportConnected`
   * - `ended`            → `endCall` (dismiss native UI)
   */
  private attachStoreSubscriber(): void {
    let prev: ActiveCall | undefined;
    this.unsubscribeStore = useCalls.subscribe((s) => {
      const next = s.active;
      this.diff(prev, next);
      prev = next;
    });
  }

  private diff(prev: ActiveCall | undefined, next: ActiveCall | undefined): void {
    const RNCallKeep = this.rnCallKeep;
    if (!RNCallKeep) return;
    if (!prev && next) {
      const uuid = this.allocUuid(next.callId);
      // Report the actual media kind so CallKit treats a video call as a
      // video call — required for the iOS background video-call context
      // that Picture-in-Picture relies on (bug #4).
      const isVideo = next.kind === 'video';
      if (next.isCaller) {
        try {
          RNCallKeep.startCall(uuid, next.peerUserId, `@${next.peerUserId}`, 'generic', isVideo);
        } catch (err) {
          diag('callkeep', 'startCall failed', { err: String(err) });
        }
      } else if (next.stage === 'incoming_ringing') {
        try {
          RNCallKeep.displayIncomingCall(
            uuid,
            next.peerUserId,
            `@${next.peerUserId}`,
            'generic',
            isVideo,
          );
        } catch (err) {
          diag('callkeep', 'displayIncomingCall failed', { err: String(err) });
        }
      }
      return;
    }
    if (!next) {
      if (prev) {
        const uuid = this.idToUuid.get(prev.callId);
        if (uuid) {
          try {
            RNCallKeep.endCall(uuid);
          } catch (err) {
            diag('callkeep', 'endCall failed', { err: String(err) });
          }
          this.idToUuid.delete(prev.callId);
          this.uuidToId.delete(uuid);
        }
      }
      return;
    }
    if (prev && prev.stage !== 'connected' && next.stage === 'connected') {
      const uuid = this.idToUuid.get(next.callId);
      if (uuid) {
        try {
          RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
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
