/**
 * Native audio-route diagnostics → the log a tester actually sends back.
 *
 * The bug this instrumentation exists for ("headphone audio fails on a paired
 * call") has to be settleable from ONE uploaded diag log: it must show which
 * route the app asked for at the moment it was decided, which devices the
 * platform had at that moment, and which route was applied. The patched
 * InCallManagerModule emits those records on the `SpeakeasyAudioFocusDiagnostics`
 * device-event channel; these tests drive the real `audioDiagnostics` listener
 * with those payloads, push a call-length flood of periodic sampling through the
 * real diag ring, and assert the route records are still in the payload
 * `uploadDiag()` posts — which is also what the Diagnostics screen's Copy Logs
 * pastes.
 *
 * The native emit itself (Java, on-device) is out of reach here; what is under
 * test is everything from the bridge payload onward.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Stand-in for the RN device-event bus the native module emits on. */
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    addListener(name: string, listener: (value: unknown) => void) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return {
        remove() {
          const rest = (listeners.get(name) ?? []).filter((l) => l !== listener);
          listeners.set(name, rest);
        },
      };
    },
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
    reset() {
      listeners.clear();
    },
  };
});

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
  NativeModules: {
    SpeakeasyAudioDiagnostics: {
      setCallId: vi.fn(),
      drain: vi.fn(async () => []),
      snapshot: vi.fn(async (trigger: string) => ({ event: 'snapshot', trigger })),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    },
  },
  NativeEventEmitter: class {
    addListener(name: string, listener: (value: unknown) => void) {
      return bus.addListener(name, listener);
    }
  },
  DeviceEventEmitter: {
    addListener: (name: string, listener: (value: unknown) => void) =>
      bus.addListener(name, listener),
  },
}));

vi.mock('../version.js', () => ({
  appVersion: () => '1.0.74-rc.3',
  isDiagnosticsBetaBuild: () => true,
}));

import { audioDiagnostics } from './audio-diagnostics.js';
import { diag, __resetDiagForTests, formatDiag } from '../diag/log.js';
import type { DiagEntry } from '../diag/log.js';
import { uploadDiag } from '../diag/upload.js';
import { useSettings } from '../store/settings.js';
import type { DiagUploadPayload } from '../api/client.js';

/** The channel name the patched `InCallManagerModule.sendEvent` uses. */
const NATIVE_CHANNEL = 'SpeakeasyAudioFocusDiagnostics';

/**
 * A record as `emitSpeakeasyAudioDiagnostics()` builds it: every field present,
 * unknown platform state explicitly null (never a false zero).
 */
function nativeRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    event: 'route changed',
    important: true,
    nativeElapsedMs: 41230,
    focusResult: null,
    requestedDevice: null,
    mode: 3,
    microphoneMuted: false,
    speakerphoneOn: true,
    selectedAudioDevice: 'SPEAKER_PHONE',
    availableAudioDevices: '[SPEAKER_PHONE, EARPIECE]',
    appTopmost: true,
    microphoneForegroundService: null,
    effectiveCommunicationDeviceType: null,
    ...over,
  };
}

/** Periodic sampling for `seconds` of call: capture, playout and webrtc stats. */
function runCallFor(seconds: number, emit: (payload: unknown) => void): void {
  for (let t = 0; t < seconds; t += 2) {
    emit({ event: 'capture samples', important: false, nativeElapsedMs: t * 1000 });
    emit({ event: 'playout samples', important: false, nativeElapsedMs: t * 1000 });
    diag('webrtc-audio', 'snapshot', { elapsed: t });
  }
}

function uploadedEntries(
  api: { uploadDiag: ReturnType<typeof vi.fn> },
): DiagEntry[] {
  const [, payload] = api.uploadDiag.mock.calls[0] as [string, DiagUploadPayload];
  return payload.entries;
}

function makeApi() {
  return {
    uploadDiag: vi.fn(
      (_token: string, _payload: DiagUploadPayload): Promise<void> => Promise.resolve(),
    ),
  };
}

beforeEach(() => {
  bus.reset();
  __resetDiagForTests();
  useSettings.setState({ diagStreaming: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('native audio-route records reach the uploaded diag log', () => {
  it('keeps the requested route, the device list and the applied route after a five-minute call', async () => {
    const stop = audioDiagnostics.start('call-headset');
    const emit = (payload: unknown) => bus.emit(NATIVE_CHANNEL, payload);

    // t≈0: focus, then the route decision, then the route the platform applied.
    emit(nativeRecord({ event: 'focus requested', focusResult: 'granted' }));
    emit(
      nativeRecord({
        event: 'route selected',
        requestedDevice: 'WIRED_HEADSET',
        selectedAudioDevice: 'SPEAKER_PHONE',
        availableAudioDevices: '[SPEAKER_PHONE, EARPIECE, WIRED_HEADSET]',
      }),
    );
    emit(
      nativeRecord({
        event: 'route changed',
        selectedAudioDevice: 'WIRED_HEADSET',
        speakerphoneOn: false,
        availableAudioDevices: '[SPEAKER_PHONE, EARPIECE, WIRED_HEADSET]',
      }),
    );

    runCallFor(300, emit); // five minutes of periodic sampling

    const api = makeApi();
    await uploadDiag({ reason: 'call_failed', callId: 'call-headset' }, {
      api,
      getDeviceToken: () => 'dvt_test',
    });

    const entries = uploadedEntries(api);
    const selected = entries.find((e) => e.msg === 'route selected');
    const changed = entries.find((e) => e.msg === 'route changed');

    expect(selected?.ctx).toMatchObject({
      requestedDevice: 'WIRED_HEADSET',
      availableAudioDevices: '[SPEAKER_PHONE, EARPIECE, WIRED_HEADSET]',
      selectedAudioDevice: 'SPEAKER_PHONE',
    });
    expect(changed?.ctx).toMatchObject({
      selectedAudioDevice: 'WIRED_HEADSET',
      speakerphoneOn: false,
    });
    expect(entries.find((e) => e.msg === 'focus requested')?.ctx).toMatchObject({
      focusResult: 'granted',
    });
    stop();
  });

  it('shows a refused headset request with the device that was dropped', async () => {
    const stop = audioDiagnostics.start('call-dropped');
    const emit = (payload: unknown) => bus.emit(NATIVE_CHANNEL, payload);

    // The headphone-failure shape: the app asks for the headset, but the
    // platform device list does not contain it yet, so the request is dropped.
    emit(
      nativeRecord({
        event: 'route select dropped',
        requestedDevice: 'WIRED_HEADSET',
        selectedAudioDevice: 'SPEAKER_PHONE',
        availableAudioDevices: '[SPEAKER_PHONE, EARPIECE]',
      }),
    );

    runCallFor(300, emit);

    const api = makeApi();
    await uploadDiag({ reason: 'call_failed', callId: 'call-dropped' }, {
      api,
      getDeviceToken: () => 'dvt_test',
    });

    const dropped = uploadedEntries(api).find((e) => e.msg === 'route select dropped');
    expect(dropped?.ctx).toMatchObject({
      requestedDevice: 'WIRED_HEADSET',
      availableAudioDevices: '[SPEAKER_PHONE, EARPIECE]',
    });
    // The whole point: requested route and available routes disagree, and the
    // log says so without needing logcat.
    expect(String(dropped?.ctx?.availableAudioDevices)).not.toContain(
      String(dropped?.ctx?.requestedDevice),
    );
    stop();
  });

  it('would lose those records if the native emit stopped marking them important', async () => {
    // Regression guard for the reported failure — an upload with zero route
    // records. Route decisions happen at t≈0, so they are the oldest audio
    // entries and are the first to roll out of the ring once the audio floor
    // is exceeded, unless the native payload marks them important.
    const stop = audioDiagnostics.start('call-ordinary');
    const emit = (payload: unknown) => bus.emit(NATIVE_CHANNEL, payload);

    emit(nativeRecord({ event: 'route selected', important: false, requestedDevice: 'WIRED_HEADSET' }));
    emit(nativeRecord({ event: 'route changed', important: false }));
    emit(nativeRecord({ event: 'route select dropped', important: false, requestedDevice: 'BLUETOOTH' }));

    runCallFor(300, emit);

    const api = makeApi();
    await uploadDiag({ reason: 'call_failed', callId: 'call-ordinary' }, {
      api,
      getDeviceToken: () => 'dvt_test',
    });

    const routeRecords = uploadedEntries(api).filter((e) => e.msg.startsWith('route '));
    expect(routeRecords).toHaveLength(0);
    expect(formatDiag(uploadedEntries(api))).not.toContain('requestedDevice');
    stop();
  });
});
