import { describe, expect, it, vi } from 'vitest';
import { reactNativeWebRtcPeerFactory } from './webrtc-peer.js';

const localStream = vi.hoisted(() => ({
  getAudioTracks: () => [{ stop: vi.fn() }],
  getVideoTracks: () => [{ stop: vi.fn() }],
  getTracks: () => [],
  toURL: () => 'local-stream',
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
  DeviceEventEmitter: {
    addListener: () => ({ remove: () => undefined }),
  },
  NativeModules: {},
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-webrtc', () => ({
  RTCIceCandidate: class {},
  RTCSessionDescription: class {},
  RTCPeerConnection: class {
    connectionState = 'new';
    iceGatheringState = 'complete';
    localDescription = { type: 'answer', sdp: 'answer-sdp' };

    addEventListener() {}
    removeEventListener() {}
    addTrack() {
      return {};
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'answer-sdp' };
    }
    async setLocalDescription(description: { type: string; sdp: string }) {
      this.localDescription = description;
    }
    close() {}
  },
  mediaDevices: {
    getUserMedia: vi.fn(async () => localStream),
  },
}));
vi.mock('react-native-incall-manager', () => ({
  default: {
    getIsWiredHeadsetPluggedIn: vi.fn(async () => false),
    setKeepScreenOn: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock('../permissions/runtime.js', () => ({
  ensureCameraPermission: vi.fn(async () => 'granted'),
  ensureMicPermission: vi.fn(async () => 'granted'),
}));
vi.mock('../diag/log.js', () => ({ diag: vi.fn(), diagImportant: vi.fn() }));
vi.mock('../native/audio-diagnostics.js', () => ({
  audioDiagnostics: {
    start: () => () => undefined,
    stop: vi.fn(),
  },
}));

describe('WebRtcCallPeer local stream subscription', () => {
  it('publishes a newly acquired stream and replays it to a late subscriber', async () => {
    const peer = await reactNativeWebRtcPeerFactory.create({
      iceServers: [],
      callId: 'call-callee',
      role: 'callee',
      mediaKind: 'video',
    });
    const early = vi.fn();
    const unsubscribe = peer.onLocalStreamURL!(early);

    expect(early).not.toHaveBeenCalled();
    await peer.createAnswer();
    expect(early).toHaveBeenCalledOnce();
    expect(early).toHaveBeenCalledWith('local-stream');

    const late = vi.fn();
    peer.onLocalStreamURL!(late);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith('local-stream');

    unsubscribe();
    peer.close();
  });
});
