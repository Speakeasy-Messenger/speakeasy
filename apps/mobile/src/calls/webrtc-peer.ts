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
      if (!ev?.candidate) return; // null = end-of-candidates
      this.localIceCb?.({
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid ?? null,
        sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
      });
    });
    pcAny.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      diag('webrtc', 'connectionstate', { state: s });
      if (s === 'connecting' || s === 'connected' || s === 'failed' || s === 'closed') {
        this.connStateCb?.(s);
      } else if (s === 'disconnected') {
        // ICE flap. WebRTC may recover; if not, we'll see `failed`
        // shortly. Don't surface this as a terminal end-state.
      }
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
