import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactNativeWebRtcPeerFactory } from './webrtc-peer.js';

const videoTrack = vi.hoisted(() => ({
  stop: vi.fn(),
  readyState: 'live',
  getSettings: vi.fn(),
  applyConstraints: vi.fn(),
}));
const localStream = vi.hoisted(() => ({
  getAudioTracks: () => [{ stop: vi.fn() }],
  getVideoTracks: () => [videoTrack],
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
  beforeEach(() => {
    let settings = { facingMode: 'user', width: 1280, height: 720, deviceId: 'front' };
    videoTrack.readyState = 'live';
    videoTrack.getSettings.mockReset().mockImplementation(() => ({ ...settings }));
    videoTrack.applyConstraints.mockReset().mockImplementation(async (constraints) => {
      await Promise.resolve();
      settings = { ...constraints, deviceId: constraints.facingMode };
    });
  });

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

  it('returns the camera facing after each switch and leaves it unchanged before capture', async () => {
    const peer = await reactNativeWebRtcPeerFactory.create({
      iceServers: [],
      callId: 'call-camera-switch',
      role: 'callee',
      mediaKind: 'video',
    });

    expect(await peer.flipCamera!()).toBeUndefined();
    await peer.createAnswer();
    expect(await peer.flipCamera!()).toBe('environment');
    expect(await peer.flipCamera!()).toBe('user');
    expect(videoTrack.applyConstraints).toHaveBeenCalledTimes(2);
    expect(videoTrack.applyConstraints).toHaveBeenNthCalledWith(1, {
      facingMode: 'environment',
      width: 1280,
      height: 720,
    });
    peer.close();
  });

  it('serializes rapid flips and waits for the confirmed camera facing', async () => {
    const peer = await reactNativeWebRtcPeerFactory.create({
      iceServers: [],
      callId: 'call-rapid-flips',
      role: 'callee',
      mediaKind: 'video',
    });
    await peer.createAnswer();
    let completeSwitch!: () => void;
    videoTrack.applyConstraints.mockImplementationOnce(
      (constraints) =>
        new Promise<void>((resolve) => {
          completeSwitch = () => {
            videoTrack.getSettings.mockReturnValue({ ...constraints });
            resolve();
          };
        }),
    );
    const firstResolved = vi.fn();
    const first = peer.flipCamera!().then((facing) => {
      firstResolved(facing);
      return facing;
    });
    const second = peer.flipCamera!();
    await Promise.resolve();
    expect(firstResolved).not.toHaveBeenCalled();
    expect(videoTrack.applyConstraints).toHaveBeenCalledTimes(1);
    videoTrack.applyConstraints.mockImplementationOnce(async (constraints) => {
      videoTrack.getSettings.mockReturnValue({ ...constraints });
    });
    completeSwitch();
    expect(await first).toBe('environment');
    expect(await second).toBe('user');
    expect(videoTrack.getSettings().facingMode).toBe('user');
    expect(videoTrack.applyConstraints).toHaveBeenNthCalledWith(2, {
      facingMode: 'user',
      width: 1280,
      height: 720,
    });
    peer.close();
  });

  it('returns the actual facing when the requested camera is unavailable', async () => {
    const peer = await reactNativeWebRtcPeerFactory.create({
      iceServers: [],
      callId: 'call-single-camera',
      role: 'callee',
      mediaKind: 'video',
    });
    await peer.createAnswer();
    videoTrack.applyConstraints.mockImplementationOnce(async () => undefined);
    expect(await peer.flipCamera!()).toBe('user');
    peer.close();
  });

  it('keeps queued flips usable after a failed switch', async () => {
    const peer = await reactNativeWebRtcPeerFactory.create({
      iceServers: [],
      callId: 'call-failed-flip',
      role: 'callee',
      mediaKind: 'video',
    });
    await peer.createAnswer();
    videoTrack.applyConstraints.mockRejectedValueOnce(new Error('camera unavailable'));
    const first = peer.flipCamera!();
    const second = peer.flipCamera!();
    expect(await first).toBeUndefined();
    expect(await second).toBe('environment');
    expect(videoTrack.getSettings().facingMode).toBe('environment');
    peer.close();
  });
});
