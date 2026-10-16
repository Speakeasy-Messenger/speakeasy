import React from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import { useCalls } from '../store/calls.js';
import { VideoCallScreen } from './VideoCallScreen.js';

const diagMock = vi.hoisted(() => vi.fn());
const dimensionsMock = vi.hoisted(() => ({ width: 390, height: 844 }));

vi.mock('react-native', () => {
  class AnimatedValue {
    interpolate() {
      return 0;
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: 'animated-view',
      createAnimatedComponent: (component: unknown) => component,
      timing: () => ({ start: () => undefined }),
    },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    },
    Platform: { OS: 'android' },
    Pressable: 'button',
    StyleSheet: {
      absoluteFill: {},
      absoluteFillObject: {},
      create: (styles: unknown) => styles,
    },
    Text: 'span',
    useWindowDimensions: () => dimensionsMock,
    View: 'section',
  };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'main' }));
vi.mock('react-native-webrtc', () => ({ RTCView: 'rtc-view' }));
vi.mock('react-native-incall-manager', () => ({
  default: {
    startRingback: vi.fn(),
    stopRingback: vi.fn(),
  },
}));
vi.mock('../components/icons/CallIcons.js', () => ({
  MicIcon: 'mic-icon',
  PhoneEndIcon: 'phone-end-icon',
  SpeakerIcon: 'speaker-icon',
}));
vi.mock('../components/Handle.js', () => ({ Handle: 'handle' }));
vi.mock('../native/pip.js', () => ({
  pip: {
    setVideoCallActive: vi.fn(),
    setSession: vi.fn(),
    onPipModeChanged: () => () => undefined,
    onPipClosed: () => () => undefined,
    onPipResize: () => () => undefined,
    onPipLifecycle: () => () => undefined,
    consumePendingClose: vi.fn(async () => false),
    drainNativeDiagnostics: vi.fn(async () => []),
  },
}));
vi.mock('../diag/log.js', () => ({ diag: diagMock }));
vi.mock('../theme/index.js', () => ({
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  useColors: () => ({
    cream: '#fff',
    divider: '#ccc',
    ink: '#000',
    primary: '#a80',
    slate: '#555',
  }),
}));

describe('VideoCallScreen local preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    diagMock.mockReset();
    Object.assign(Platform, { OS: 'android' });
    dimensionsMock.width = 390;
    dimensionsMock.height = 844;
    useCalls.setState({
      active: {
        callId: 'call-callee',
        peerUserId: 'caller',
        isCaller: false,
        stage: 'connected',
        stageEnteredAt: 1,
        connectedAt: 1,
        micMuted: false,
        speakerOn: true,
        kind: 'video',
      },
    });
  });

  afterEach(() => {
    useCalls.setState({ active: undefined });
    vi.useRealTimers();
  });

  it('mounts the front-camera corner self-view when callee capture arrives late', async () => {
    let publishLocal: ((url: string | undefined) => void) | undefined;
    const unsubscribeLocal = vi.fn();
    const unsubscribeRemote = vi.fn();
    const orchestrator = {
      getLocalStreamURL: vi.fn(() => undefined),
      onLocalStreamURL: vi.fn((cb: (url: string | undefined) => void) => {
        publishLocal = cb;
        return unsubscribeLocal;
      }),
      onRemoteStreamURL: vi.fn((cb: (url: string | undefined) => void) => {
        cb('remote-stream');
        return unsubscribeRemote;
      }),
      hangup: vi.fn(),
      setMicMuted: vi.fn(),
      setSpeakerOn: vi.fn(),
      flipCamera: vi.fn(async () => undefined),
    } as unknown as CallOrchestrator;

    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        React.createElement(VideoCallScreen, {
          orchestrator,
          onClosed: vi.fn(),
        }),
      );
    });

    expect(tree!.root.findAllByProps({ testID: 'video-call-pip' })).toHaveLength(0);

    // A flip attempted before capture is a peer no-op and must not change
    // how the eventual front-camera preview is drawn.
    await act(async () => {
      tree!.root.findByProps({ testID: 'video-call-flip' }).props.onPress();
      await Promise.resolve();
    });

    // Reproduce capture arriving after both reads in the old 600 ms poll.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(tree!.root.findAllByProps({ testID: 'video-call-pip' })).toHaveLength(0);
    act(() => publishLocal?.('local-stream'));

    const bubble = tree!.root.findByProps({ testID: 'video-call-pip' });
    expect(bubble.findByProps({ streamURL: 'local-stream' }).type).toBe('rtc-view');
    expect(bubble.findByProps({ streamURL: 'local-stream' }).props.mirror).toBe(true);
    expect(diagMock).toHaveBeenCalledWith(
      'call',
      'video slot assignment',
      expect.objectContaining({
        bubble: 'local',
        localUrlPresent: true,
        stage: 'connected',
      }),
    );

    act(() => tree!.unmount());
    expect(unsubscribeLocal).toHaveBeenCalledOnce();
    expect(unsubscribeRemote).toHaveBeenCalledOnce();
  });

  it.each(['android', 'ios'] as const)(
    'mirrors only the front camera in the %s connected bubble and swapped fullscreen view',
    async (platform) => {
      Object.assign(Platform, { OS: platform });
      const flipCamera = vi.fn().mockResolvedValueOnce('environment').mockResolvedValueOnce('user');
      const orchestrator = {
        onLocalStreamURL: (cb: (url: string) => void) => {
          cb('local-stream');
          return () => undefined;
        },
        onRemoteStreamURL: (cb: (url: string) => void) => {
          cb('remote-stream');
          return () => undefined;
        },
        flipCamera,
      } as unknown as CallOrchestrator;
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(React.createElement(VideoCallScreen, { orchestrator, onClosed: vi.fn() }));
      });

      const view = (url: string) => tree!.root.findByProps({ streamURL: url });
      expect(view('local-stream').props.mirror).toBe(true);
      expect(view('remote-stream').props.mirror).toBe(false);

      await act(async () => {
        tree!.root.findByProps({ testID: 'video-call-flip' }).props.onPress();
        await Promise.resolve();
      });
      expect(view('local-stream').props.mirror).toBe(false);
      expect(view('remote-stream').props.mirror).toBe(false);

      act(() => tree!.root.findByProps({ testID: 'video-call-pip' }).props.onPress());
      expect(view('local-stream').props.mirror).toBe(false);
      expect(view('remote-stream').props.mirror).toBe(false);

      await act(async () => {
        tree!.root.findByProps({ testID: 'video-call-flip' }).props.onPress();
        await Promise.resolve();
      });
      expect(view('local-stream').props.mirror).toBe(true);
      expect(view('remote-stream').props.mirror).toBe(false);
      act(() => tree!.unmount());
    },
  );

  it('uses camera facing for the local fullscreen and Android compact fallback', async () => {
    const orchestrator = {
      onLocalStreamURL: (cb: (url: string) => void) => {
        cb('local-stream');
        return () => undefined;
      },
      onRemoteStreamURL: () => () => undefined,
      flipCamera: vi.fn(async () => 'environment'),
    } as unknown as CallOrchestrator;
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(React.createElement(VideoCallScreen, { orchestrator, onClosed: vi.fn() }));
    });
    const localView = () => tree!.root.findByProps({ streamURL: 'local-stream' });
    expect(localView().props.mirror).toBe(true);

    await act(async () => {
      tree!.root.findByProps({ testID: 'video-call-flip' }).props.onPress();
      await Promise.resolve();
    });
    expect(localView().props.mirror).toBe(false);

    act(() => {
      dimensionsMock.width = 200;
      tree!.update(React.createElement(VideoCallScreen, { orchestrator, onClosed: vi.fn() }));
    });
    expect(localView().props.mirror).toBe(false);
    act(() => tree!.unmount());
  });
});
