import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from './orchestrator.js';
import type { ActiveCall } from './types.js';
import { useCalls } from '../store/calls.js';

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

  constructor(private readonly deps: BridgeDeps) {}

  async start(): Promise<void> {
    if (this.setupDone) return;
    try {
      await RNCallKeep.setup({
        ios: {
          appName: this.deps.appName ?? 'Speakeasy',
          // Spec §1: zero PII. Don't surface our calls in the
          // device's iCloud-synced Recents list.
          includesCallsInRecents: false,
          supportsVideo: false,
          maximumCallGroups: '1',
          maximumCallsPerCallGroup: '1',
        },
        android: {
          alertTitle: 'Permissions required',
          alertDescription:
            'Speakeasy needs phone-account permission to display calls in the system UI.',
          cancelButton: 'Cancel',
          okButton: 'OK',
          additionalPermissions: [],
          // Foreground service is auto-managed by CallKeep on Android
          // when this is set — we get a system call notification while
          // a call is active so the OS doesn't kill our process.
          foregroundService: {
            channelId: 'xyz.speakeasyapp.app.calls',
            channelName: 'Active calls',
            notificationTitle: 'Speakeasy call in progress',
            notificationIcon: 'ic_launcher',
          },
        },
      });
      if (Platform.OS === 'android') {
        RNCallKeep.registerAndroidEvents();
        RNCallKeep.setAvailable(true);
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
    if (!this.setupDone) return;
    RNCallKeep.removeEventListener('answerCall');
    RNCallKeep.removeEventListener('endCall');
    RNCallKeep.removeEventListener('didPerformSetMutedCallAction');
    RNCallKeep.removeEventListener('didActivateAudioSession');
    RNCallKeep.removeEventListener('didDeactivateAudioSession');
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.setupDone = false;
  }

  private attachListeners(): void {
    RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      const callId = this.uuidToId.get(callUUID);
      diag('callkeep', 'answerCall', { callUUID, callId });
      if (!callId) return;
      void this.deps.orchestrator.accept().catch((err) => {
        diag('callkeep', 'accept failed', { err: String(err) });
      });
    });
    RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
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
    RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({ muted }) => {
      diag('callkeep', 'mute toggle', { muted });
      this.deps.orchestrator.setMicMuted(muted);
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
    if (!prev && next) {
      const uuid = this.allocUuid(next.callId);
      if (next.isCaller) {
        try {
          RNCallKeep.startCall(uuid, next.peerUserId, `@${next.peerUserId}`, 'generic', false);
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
            false,
          );
        } catch (err) {
          diag('callkeep', 'displayIncomingCall failed', { err: String(err) });
        }
      }
      return;
    }
    if (!next) {
      // Call ended — dismiss any native UI.
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
    // Same call — track stage transitions that matter to the OS.
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
