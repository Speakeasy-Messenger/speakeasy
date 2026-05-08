import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
  type MediaStream,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import type {
  CallAnswerPayload,
  CallIceCandidate,
  CallIcePayload,
  CallOfferPayload,
} from '@speakeasy/shared';
import type { CallPeer, CallPeerFactory, IceServer } from './types.js';
import { diag } from '../diag/log.js';

/**
 * `react-native-webrtc`-backed `CallPeer` implementation. Audio-only;
 * video is post-MVP per spec §1.
 *
 * Audio routing is delegated to `InCallManager` — proximity sensor,
 * speaker on/off, audio focus. Started on call setup, stopped on close.
 *
 * The orchestrator is responsible for ringing-window timeouts and the
 * Signal-encrypted SDP envelope; this class only mirrors the local
 * `RTCPeerConnection` events into the orchestrator's structured
 * payload types.
 */
class WebRtcCallPeer implements CallPeer {
  private readonly pc: RTCPeerConnection;
  private localStream?: MediaStream;
  private localIceCb?: (c: CallIceCandidate) => void;
  private connStateCb?: (
    s: 'connecting' | 'connected' | 'failed' | 'closed',
  ) => void;
  private startedManager = false;
  // Phase 5 — audio-level polling.
  // `audioLevelCb` is set when a UI subscribes; the polling loop only
  // runs while at least one subscriber is alive. We poll instead of
  // pushing because RN-WebRTC has no AudioLevelObserver event yet, but
  // every modern WebRTC stack populates `audioLevel` on getStats output.
  private audioLevelCb?: (levels: { local: number; remote: number }) => void;
  private audioLevelTimer?: ReturnType<typeof setInterval>;

  constructor(iceServers: IceServer[]) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      // `bundle-policy: max-bundle` keeps audio on a single
      // ICE/DTLS pair — one less moving part to NAT-traverse.
      bundlePolicy: 'max-bundle',
    });

    // RN-WebRTC's EventTarget shim doesn't expose addEventListener via
    // its TS surface in a way that's easy to call from generic code, so
    // we go through `any`. The runtime API matches the W3C spec.
    const pcAny = this.pc as any;
    pcAny.addEventListener('icecandidate', (ev: any) => {
      if (!ev?.candidate) {
        diag('webrtc', 'local ice: end-of-candidates');
        return; // null = end-of-candidates
      }
      // Parse the candidate `typ` token so we can see at a glance
      // whether the device is generating relay (TURN) candidates —
      // critical when ICE goes connecting → closed and we can't tell
      // if the TURN credentials silently failed.
      const cand = ev.candidate.candidate as string;
      const typMatch = cand.match(/ typ (\S+)/);
      const candType = typMatch ? typMatch[1] : 'unknown';
      diag('webrtc', 'local ice candidate', { type: candType });
      this.localIceCb?.({
        candidate: cand,
        sdpMid: ev.candidate.sdpMid ?? null,
        sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
      });
    });
    pcAny.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      diag('webrtc', 'connectionstate', { state: s });
      // When we drop into 'connecting' or 'failed', sample the inner
      // ICE state machine + selected pair via getStats — that's where
      // the real "why didn't this work" signal lives. The browser-spec
      // top-level `connectionState` only summarizes; its sub-states are
      // ice / dtls connection states.
      if (s === 'connecting' || s === 'failed' || s === 'closed' || s === 'disconnected') {
        void this.dumpIceStats(s);
      }
      if (s === 'connecting' || s === 'connected' || s === 'failed' || s === 'closed') {
        this.connStateCb?.(s);
      } else if (s === 'disconnected') {
        // ICE flap. WebRTC may recover; if not, we'll see `failed`
        // shortly. Don't surface this as a terminal end-state.
      }
    });
    pcAny.addEventListener('iceconnectionstatechange', () => {
      const s = (this.pc as any).iceConnectionState;
      diag('webrtc', 'iceconnectionstate', { state: s });
    });
    pcAny.addEventListener('icegatheringstatechange', () => {
      const s = (this.pc as any).iceGatheringState;
      diag('webrtc', 'icegatheringstate', { state: s });
    });

    // Attach the track event so the inbound audio stream gets routed
    // to the device speaker. We don't render anything (audio-only).
    pcAny.addEventListener('track', (ev: any) => {
      const remoteStream: MediaStream | undefined = ev.streams?.[0];
      diag('webrtc', 'remote track', {
        kind: ev.track?.kind,
        hasStream: !!remoteStream,
      });
      // Once we have remote media, ensure the audio session is hot.
      // InCallManager.start is idempotent.
      this.ensureManager();
    });
  }

  async createOffer(): Promise<CallOfferPayload> {
    await this.ensureLocalStream();
    const offer = await this.pc.createOffer({});
    await this.pc.setLocalDescription(offer);
    // Wait briefly for ICE gathering to surface a few host candidates
    // before sending — trickle ICE follows up with whatever else
    // shows up. Keeping this small (200ms) avoids ringing latency.
    await waitForInitialIce(this.pc, 200);
    const desc = this.pc.localDescription!;
    return { v: 1, sdp: desc.sdp, candidates: [] };
  }

  async setRemoteOffer(payload: CallOfferPayload): Promise<void> {
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }),
    );
    for (const c of payload.candidates) {
      await this.addRemoteIce({ v: 1, candidates: [c] });
    }
  }

  async createAnswer(): Promise<CallAnswerPayload> {
    await this.ensureLocalStream();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForInitialIce(this.pc, 200);
    const desc = this.pc.localDescription!;
    return { v: 1, sdp: desc.sdp, candidates: [] };
  }

  async setRemoteAnswer(payload: CallAnswerPayload): Promise<void> {
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }),
    );
    for (const c of payload.candidates) {
      await this.addRemoteIce({ v: 1, candidates: [c] });
    }
  }

  /**
   * Sample the inner ICE stats via `pc.getStats()` and emit a single
   * diag entry summarizing the selected candidate pair (if any) +
   * counts by candidate type. Intentionally compact — gets dumped on
   * every `connectionstate` transition into a non-connected state so
   * the diagnostic log shows exactly where ICE is.
   *
   * Without this, "connectionstate: closed" is the only signal and
   * we can't distinguish "TURN credentials wrong" from "both peers
   * behind symmetric NAT" from "all candidates host-only because
   * STUN couldn't reach the public internet."
   */
  private async dumpIceStats(trigger: string): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let local: any = undefined;
      let remote: any = undefined;
      let pair: any = undefined;
      const localById = new Map<string, any>();
      const remoteById = new Map<string, any>();
      let localCount = 0;
      let relayCount = 0;
      let srflxCount = 0;
      let hostCount = 0;
      stats.forEach((report: any) => {
        if (report.type === 'local-candidate') {
          localById.set(report.id, report);
          localCount += 1;
          if (report.candidateType === 'relay') relayCount += 1;
          else if (report.candidateType === 'srflx') srflxCount += 1;
          else if (report.candidateType === 'host') hostCount += 1;
        } else if (report.type === 'remote-candidate') {
          remoteById.set(report.id, report);
        } else if (report.type === 'candidate-pair') {
          // We want the selected (or nominated, or in-progress) pair.
          // RN-WebRTC doesn't always set `selected` — fall back to
          // `nominated` then highest-priority succeeded.
          if (report.selected || report.nominated || (!pair && report.state === 'succeeded')) {
            pair = report;
          }
        }
      });
      if (pair) {
        local = localById.get(pair.localCandidateId);
        remote = remoteById.get(pair.remoteCandidateId);
      }
      diag('webrtc', `ice stats @ ${trigger}`, {
        localCands: localCount,
        host: hostCount,
        srflx: srflxCount,
        relay: relayCount,
        pairState: pair?.state,
        nominated: pair?.nominated,
        localType: local?.candidateType,
        remoteType: remote?.candidateType,
        localProto: local?.protocol,
        remoteProto: remote?.protocol,
      });
    } catch (err) {
      diag('webrtc', 'getStats failed', { err: String(err) });
    }
  }

  async addRemoteIce(payload: CallIcePayload): Promise<void> {
    for (const c of payload.candidates) {
      try {
        await this.pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: c.candidate,
            sdpMid: c.sdpMid ?? undefined,
            sdpMLineIndex: c.sdpMLineIndex ?? undefined,
          }),
        );
      } catch (err) {
        // Stale or duplicate candidate — non-fatal.
        diag('webrtc', 'addIceCandidate failed', { err: String(err) });
      }
    }
  }

  onLocalIce(cb: (c: CallIceCandidate) => void): () => void {
    this.localIceCb = cb;
    return () => {
      if (this.localIceCb === cb) this.localIceCb = undefined;
    };
  }

  onConnectionStateChange(
    cb: (s: 'connecting' | 'connected' | 'failed' | 'closed') => void,
  ): () => void {
    this.connStateCb = cb;
    return () => {
      if (this.connStateCb === cb) this.connStateCb = undefined;
    };
  }

  /**
   * Audio-level polling. Spec §5 (in-call animal mouth animation):
   * sample local + remote `audioLevel` from `pc.getStats()` at ~12 Hz
   * and push to the subscriber. The mouth scale interpolation lives in
   * AvatarRenderer; this just produces the raw signal.
   *
   * 80ms polling cadence chosen for a balance between responsiveness
   * (mouth tracks speech onset within one or two frames) and CPU cost
   * (getStats walks every active stream). Most desktop browsers run
   * the WebRTC audio-level meter at 100ms; we sit just under that.
   *
   * `audioLevel` reported by the spec is RMS-derived and already in
   * [0, 1] — no normalization needed. Floors at 0.
   */
  onAudioLevels(
    cb: (levels: { local: number; remote: number }) => void,
  ): () => void {
    this.audioLevelCb = cb;
    if (!this.audioLevelTimer) {
      this.audioLevelTimer = setInterval(() => {
        void this.sampleAudioLevels();
      }, 80);
    }
    return () => {
      if (this.audioLevelCb === cb) this.audioLevelCb = undefined;
      if (!this.audioLevelCb && this.audioLevelTimer) {
        clearInterval(this.audioLevelTimer);
        this.audioLevelTimer = undefined;
      }
    };
  }

  private async sampleAudioLevels(): Promise<void> {
    if (!this.audioLevelCb) return;
    let local = 0;
    let remote = 0;
    try {
      const stats = await this.pc.getStats();
      stats.forEach((report: any) => {
        // Local mic level: `media-source` with kind=audio carries
        // `audioLevel` (Chrome / RN-WebRTC). Some impls report the same
        // value on `outbound-rtp` instead — accept either as a fallback.
        if (
          (report.type === 'media-source' && report.kind === 'audio') ||
          (report.type === 'outbound-rtp' && report.kind === 'audio')
        ) {
          if (typeof report.audioLevel === 'number') {
            local = Math.max(local, report.audioLevel);
          }
        }
        // Remote level: `inbound-rtp` audio carries the receive-side
        // `audioLevel`, computed by the receiver from the decoded
        // PCM (not the network-side `voiceActivityFlag`).
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          if (typeof report.audioLevel === 'number') {
            remote = Math.max(remote, report.audioLevel);
          }
        }
      });
    } catch {
      // Silently ignore — getStats can throw mid-teardown. Stale reads
      // are fine; the next tick gets the next snapshot.
      return;
    }
    this.audioLevelCb?.({ local, remote });
  }

  setMicMuted(muted: boolean): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) {
      (track as MediaStreamTrack).enabled = !muted;
    }
    InCallManager.setMicrophoneMute(muted);
  }

  setSpeakerOn(on: boolean): void {
    InCallManager.setForceSpeakerphoneOn(on);
  }

  close(): void {
    if (this.audioLevelTimer) {
      clearInterval(this.audioLevelTimer);
      this.audioLevelTimer = undefined;
    }
    this.audioLevelCb = undefined;
    try {
      if (this.localStream) {
        for (const t of this.localStream.getTracks()) {
          (t as MediaStreamTrack).stop();
        }
      }
      this.pc.close();
    } catch (err) {
      diag('webrtc', 'close error', { err: String(err) });
    }
    if (this.startedManager) {
      InCallManager.stop({});
      this.startedManager = false;
    }
  }

  private async ensureLocalStream(): Promise<void> {
    if (this.localStream) return;
    this.ensureManager();
    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })) as MediaStream;
    this.localStream = stream;
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track as MediaStreamTrack, stream);
    }
  }

  private ensureManager(): void {
    if (this.startedManager) return;
    InCallManager.start({ media: 'audio' });
    InCallManager.setKeepScreenOn(true);
    this.startedManager = true;
  }
}

/** Wait up to `maxMs` for at least one local ICE candidate. */
function waitForInitialIce(pc: RTCPeerConnection, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const pcAny = pc as any;
    const t = setTimeout(() => {
      pcAny.removeEventListener('icegatheringstatechange', handler);
      resolve();
    }, maxMs);
    function handler(): void {
      if (pc.iceGatheringState !== 'new') {
        clearTimeout(t);
        pcAny.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    }
    pcAny.addEventListener('icegatheringstatechange', handler);
  });
}

export const reactNativeWebRtcPeerFactory: CallPeerFactory = {
  async create(opts): Promise<CallPeer> {
    return new WebRtcCallPeer(opts.iceServers);
  },
};
