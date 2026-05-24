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
import type { CallMediaKind, CallPeer, CallPeerFactory, IceServer } from './types.js';
import { ANIMATION_CHANNEL_LABEL } from './animation-channel.js';
import {
  ensureCameraPermission,
  ensureMicPermission,
} from '../permissions/runtime.js';
import { diag } from '../diag/log.js';
import { utf8ToBytes } from '../utils/bytes.js';

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
  private remoteStream?: MediaStream;
  private localIceCb?: (c: CallIceCandidate) => void;
  private connStateCb?: (
    s: 'connecting' | 'connected' | 'failed' | 'closed',
  ) => void;
  private remoteStreamCb?: (url: string | undefined) => void;
  private startedManager = false;
  /** Last requested speaker state — re-applied on (re)connect. */
  private speakerOn = false;
  private cameraFacing: 'user' | 'environment' = 'user';
  // Phase 5 — audio-level polling.
  // `audioLevelCb` is set when a UI subscribes; the polling loop only
  // runs while at least one subscriber is alive. We poll instead of
  // pushing because RN-WebRTC has no AudioLevelObserver event yet, but
  // every modern WebRTC stack populates `audioLevel` on getStats output.
  private audioLevelCb?: (levels: { local: number; remote: number }) => void;
  private audioLevelTimer?: ReturnType<typeof setInterval>;
  /**
   * Phase 5j Private Call — animation data channel. The caller
   * creates this in `openAnimationDataChannel()` BEFORE createOffer
   * so the SDP includes the channel's m-section; the callee discovers
   * it via the `datachannel` event on its peer connection. Both
   * sides converge on the canonical label so the channel pairs up
   * regardless of negotiation order.
   *
   * Holds the `RTCDataChannel` once it's open. Undefined for non-
   * Private calls (channel never opened) or before negotiation
   * completes. `sendAnimationFrame` no-ops in either case — the
   * dropped frame just means the receiver sees one extra mouth-idle
   * tick (~33 ms), which is invisible.
   */
  private animationChannel?: any;
  private animationFrameCb?: (payload: Uint8Array) => void;

  constructor(iceServers: IceServer[], private readonly mediaKind: CallMediaKind = 'audio') {
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
    // Phase 5j — receiver side picks up the caller's animation data
    // channel here. The `datachannel` event fires once per channel
    // the remote opens; we accept ours by label and ignore anything
    // else (no other RTCDataChannels exist in Speakeasy today).
    pcAny.addEventListener('datachannel', (ev: any) => {
      const ch = ev?.channel;
      if (!ch || ch.label !== ANIMATION_CHANNEL_LABEL) return;
      this.bindAnimationChannel(ch);
      diag('webrtc', 'animation data channel accepted (callee side)');
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
      if (s === 'connected') {
        // Re-assert audio routing now that media is flowing — see
        // reassertAudioRoute() for the callee-mic bug this addresses.
        this.reassertAudioRoute();
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

    // Attach the track event so inbound media gets routed. Audio runs
    // through the device speaker via InCallManager; video streams need
    // the URL surfaced via onRemoteStreamURL so VideoCallScreen can
    // render an RTCView.
    pcAny.addEventListener('track', (ev: any) => {
      const stream: MediaStream | undefined = ev.streams?.[0];
      diag('webrtc', 'remote track', {
        kind: ev.track?.kind,
        hasStream: !!stream,
      });
      this.ensureManager();
      // The first stream containing a video track is the one we render.
      // Re-fires of `track` for additional audio tracks within the same
      // stream are ignored — we keep the first stream URL stable.
      if (stream && (this.mediaKind === 'video' || ev.track?.kind === 'video')) {
        if (!this.remoteStream) {
          this.remoteStream = stream;
          const url = (stream as { toURL?: () => string }).toURL?.();
          this.remoteStreamCb?.(url);
        }
      }
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
    this.speakerOn = on;
    diag('webrtc', 'setSpeakerOn', { on });
    InCallManager.setForceSpeakerphoneOn(on);
  }

  close(): void {
    if (this.audioLevelTimer) {
      clearInterval(this.audioLevelTimer);
      this.audioLevelTimer = undefined;
    }
    this.audioLevelCb = undefined;
    if (this.animationChannel) {
      try {
        this.animationChannel.close();
      } catch {
        /* channel may already be closed by the pc close below */
      }
      this.animationChannel = undefined;
    }
    this.animationFrameCb = undefined;
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

  // ---------- Private Call animation data channel ----------

  openAnimationDataChannel(): void {
    if (this.animationChannel) return;
    // Locked settings: unreliable + unordered (fresh-or-drop). One
    // dropped frame = brief mouth idle on the receiver; an ordered
    // channel would block for 200+ ms recovering a frame the avatar
    // has already moved past.
    const ch = (this.pc as any).createDataChannel(ANIMATION_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    this.bindAnimationChannel(ch);
    diag('webrtc', 'animation data channel opened (caller side)');
  }

  onAnimationFrame(cb: (payload: Uint8Array) => void): () => void {
    this.animationFrameCb = cb;
    return () => {
      if (this.animationFrameCb === cb) this.animationFrameCb = undefined;
    };
  }

  sendAnimationFrame(payload: Uint8Array): void {
    const ch = this.animationChannel;
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(payload);
    } catch {
      // The native side may throw transiently while the channel
      // tears down. Fresh-or-drop — let the next frame retry.
    }
  }

  private bindAnimationChannel(ch: any): void {
    this.animationChannel = ch;
    ch.addEventListener?.('message', (ev: any) => {
      const data = ev?.data;
      if (!data) return;
      // The RN-WebRTC datachannel `message` event carries `data` as
      // either a string or an ArrayBuffer depending on what the
      // sender shipped. Speakeasy always ships binary; normalize
      // string inputs to Uint8Array via UTF-8 bytes just so a future
      // wire-format experiment doesn't NPE here.
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        // Hermes ships without a global TextEncoder despite RN docs
        // claiming otherwise (the no-hermes-banned-globals integration
        // test catches this). Use the project's utf8ToBytes helper.
        bytes = utf8ToBytes(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(
          (data as ArrayBufferView).buffer,
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength,
        );
      } else {
        return;
      }
      this.animationFrameCb?.(bytes);
    });
    // The channel might not be `open` immediately — log when it
    // transitions so a "first 100 ms of mouth idle" report has data.
    ch.addEventListener?.('open', () => {
      diag('webrtc', 'animation data channel open', {
        label: ch.label,
      });
    });
    ch.addEventListener?.('close', () => {
      diag('webrtc', 'animation data channel closed');
    });
  }

  private async ensureLocalStream(): Promise<void> {
    if (this.localStream) return;
    // Just-in-time mic + camera permission. Mic is asked on the first
    // call (caller's createOffer or callee's createAnswer); camera on
    // the first video call. iOS handles both via Info.plist + the OS
    // dialog raised by getUserMedia and these helpers no-op. On
    // denial we throw a typed error so the orchestrator can end the
    // call cleanly — the helper has already shown the Open Settings
    // alert if the user previously picked "Don't ask again".
    const mic = await ensureMicPermission();
    if (mic !== 'granted') {
      throw new Error(`mic permission ${mic}`);
    }
    if (this.mediaKind === 'video') {
      const cam = await ensureCameraPermission();
      if (cam !== 'granted') {
        throw new Error(`camera permission ${cam}`);
      }
    }
    this.ensureManager();
    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video:
        this.mediaKind === 'video'
          ? {
              // Front camera by default — phone-call etiquette. The
              // VideoCallScreen exposes a flip control via flipCamera().
              facingMode: this.cameraFacing,
              // 720p target. RN-WebRTC will negotiate down on weak
              // networks via the SDP; this is just the upper bound.
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 },
            }
          : false,
    })) as MediaStream;
    this.localStream = stream;
    diag('webrtc', 'local media acquired', {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
    });
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track as MediaStreamTrack, stream);
    }
    if (this.mediaKind === 'video') {
      for (const track of stream.getVideoTracks()) {
        this.pc.addTrack(track as MediaStreamTrack, stream);
      }
    }
  }

  getLocalStreamURL(): string | undefined {
    return (this.localStream as { toURL?: () => string } | undefined)?.toURL?.();
  }

  onRemoteStreamURL(cb: (url: string | undefined) => void): () => void {
    this.remoteStreamCb = cb;
    // Fire immediately if the stream already arrived before the
    // subscription (callee path can hit this).
    if (this.remoteStream) {
      const url = (this.remoteStream as { toURL?: () => string }).toURL?.();
      cb(url);
    }
    return () => {
      if (this.remoteStreamCb === cb) this.remoteStreamCb = undefined;
    };
  }

  async flipCamera(): Promise<void> {
    if (this.mediaKind !== 'video' || !this.localStream) return;
    // RN-WebRTC's local video tracks expose `_switchCamera()` as a
    // non-standard convenience that toggles facingMode without re-
    // negotiating. Cheaper than tearing down the track + getUserMedia
    // again. Falls back to a manual replace if the helper is missing.
    for (const track of this.localStream.getVideoTracks()) {
      const t = track as unknown as { _switchCamera?: () => void };
      if (typeof t._switchCamera === 'function') {
        t._switchCamera();
      }
    }
    this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
  }

  private ensureManager(): void {
    if (this.startedManager) return;
    // `auto: true` lets the OS pick earpiece for audio-only calls
    // (the natural default for a phone-call style flow). The previous
    // implicit speakerphone routing was a user complaint — calls
    // would broadcast on speaker the moment they connected. The
    // user's mute / speaker controls in CallScreen still flip
    // `setForceSpeakerphoneOn(true|false)` on demand.
    InCallManager.start({ media: 'audio', auto: true });
    InCallManager.setForceSpeakerphoneOn(this.speakerOn);
    InCallManager.setKeepScreenOn(true);
    this.startedManager = true;
    diag('webrtc', 'InCallManager started', { speakerOn: this.speakerOn });
  }

  /**
   * Re-apply the audio route once the peer connection reaches
   * `connected`. On some Android devices the routing set by
   * `InCallManager.start()` doesn't engage the mic-capture path until
   * a route change occurs — the symptom being a callee whose audio the
   * caller can't hear until the callee manually toggles speakerphone
   * (which is itself just another `setForceSpeakerphoneOn` call).
   * Re-asserting the intended route here reproduces that toggle
   * automatically, without changing what the user hears.
   */
  private reassertAudioRoute(): void {
    if (!this.startedManager) return;
    InCallManager.setForceSpeakerphoneOn(this.speakerOn);
    diag('webrtc', 'audio route re-asserted (connected)', {
      speakerOn: this.speakerOn,
    });
  }

  /**
   * Start playing the system ringback tone — what the *caller* hears
   * while their device is still trying to reach the peer. Stopped by
   * `stopRingback()` once the peer answers.
   *
   * Per CALLS.md §02 we want a calmer, owl-with-forest-ambient bed
   * eventually. For Phase 1 the system default ringtone is a
   * placeholder — at least it stops the silent-while-waiting
   * sensation users were reporting.
   */
  startRingback(): void {
    try {
      InCallManager.startRingback('_DEFAULT_');
    } catch (err) {
      diag('webrtc', 'ringback start error', { err: String(err) });
    }
  }

  stopRingback(): void {
    try {
      InCallManager.stopRingback();
    } catch (err) {
      diag('webrtc', 'ringback stop error', { err: String(err) });
    }
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
    return new WebRtcCallPeer(opts.iceServers, opts.mediaKind ?? 'audio');
  },
};
