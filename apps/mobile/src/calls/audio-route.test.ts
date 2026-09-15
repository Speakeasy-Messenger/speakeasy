import { describe, expect, it } from 'vitest';
import {
  AudioRouteController,
  type AudioRoute,
  type RouteRequestResult,
} from './audio-route.js';

/**
 * Regression coverage for the confirmed Android bug: voice calls were silent
 * in both directions when a headset was connected BEFORE the call started,
 * while connecting it after the call was up worked. The pre-fix
 * `webrtc-peer.ts` seeded the headset state from an async
 * `getIsWiredHeadsetPluggedIn()` query and then applied the first route on the
 * very next line, so the first route always saw `headsetPlugged = false`,
 * forced the earpiece, and pinned InCallManager's `userSelectedAudioDevice`.
 *
 * These tests exercise the decision sequence directly through a fake platform
 * (native is not runnable in CI): a headset present at call start must end on
 * the headset route, a headset plugged in mid-call must still switch, and a
 * route request the platform drops while its device set is empty must be
 * observable and retried once the device appears.
 */

/** Flush the microtasks a resolved `request()` promise schedules. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  controller: AudioRouteController;
  requests: AudioRoute[];
  applied: AudioRoute[];
  important: string[];
  logs: string[];
  platformAvailable: Set<string>;
}

function harness(options: { deviceSetRequired?: boolean; initialSpeakerOn?: boolean } = {}): Harness {
  const requests: AudioRoute[] = [];
  const applied: AudioRoute[] = [];
  const important: string[] = [];
  const logs: string[] = [];
  // Mirrors native: speaker + earpiece always exist; a headset route is only
  // selectable once it is in the platform device set.
  const platformAvailable = new Set<string>(['SPEAKER_PHONE', 'EARPIECE']);
  const controller = new AudioRouteController({
    initialSpeakerOn: options.initialSpeakerOn ?? false,
    deviceSetRequired: options.deviceSetRequired ?? true,
    ports: {
      request: async (route): Promise<RouteRequestResult> => {
        requests.push(route);
        const accepted = platformAvailable.has(route);
        if (accepted) applied.push(route);
        return { accepted };
      },
      log: (event) => {
        logs.push(event);
      },
      logImportant: (event) => {
        important.push(event);
      },
    },
  });
  return { controller, requests, applied, important, logs, platformAvailable };
}

describe('AudioRouteController headset routing', () => {
  it('waits for the headset seed and routes a pre-connected headset to the headset', async () => {
    const h = harness();
    h.controller.start();
    // The Android device set arrives before the async headset query — the
    // exact ordering that used to decide the first route on a false seed.
    h.platformAvailable.add('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'WIRED_HEADSET', 'EARPIECE']);
    await flush();
    expect(h.requests).toEqual([]);

    h.controller.resolveHeadsetSeed(true);
    await flush();

    expect(h.requests).toEqual(['WIRED_HEADSET']);
    expect(h.requests).not.toContain('EARPIECE');
    expect(h.applied).toEqual(['WIRED_HEADSET']);
  });

  it('never forces the earpiece while a pre-connected headset is present', async () => {
    const h = harness();
    h.controller.start();
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(true);
    // The seed lands before the library has repopulated WIRED_HEADSET.
    await flush();
    expect(h.requests).toEqual(['WIRED_HEADSET']);

    h.platformAvailable.add('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'WIRED_HEADSET', 'EARPIECE']);
    await flush();

    expect(h.requests).not.toContain('EARPIECE');
    expect(h.applied).toEqual(['WIRED_HEADSET']);
  });

  it('routes a headset plugged in mid-call, after the earpiece was already applied', async () => {
    const h = harness();
    h.controller.start();
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(false);
    await flush();
    expect(h.applied).toEqual(['EARPIECE']);

    h.controller.updateHeadset(true);
    h.platformAvailable.add('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'WIRED_HEADSET', 'EARPIECE']);
    await flush();

    expect(h.applied).toEqual(['EARPIECE', 'WIRED_HEADSET']);
  });

  it('restores the speaker preference when a headset is unplugged', async () => {
    const h = harness({ initialSpeakerOn: true });
    h.controller.start();
    h.platformAvailable.add('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'WIRED_HEADSET', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(true);
    await flush();
    expect(h.applied).toEqual(['WIRED_HEADSET']);

    h.controller.updateHeadset(false);
    h.platformAvailable.delete('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    await flush();

    expect(h.applied).toEqual(['WIRED_HEADSET', 'SPEAKER_PHONE']);
  });

  it('prefers Bluetooth over wired, matching InCallManager preference order', async () => {
    const h = harness();
    h.controller.start();
    h.platformAvailable.add('BLUETOOTH');
    h.controller.updateDevices(['SPEAKER_PHONE', 'BLUETOOTH', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(false);
    await flush();

    expect(h.applied).toEqual(['BLUETOOTH']);
  });

  it('makes a dropped route request observable instead of silent', async () => {
    const h = harness();
    h.controller.start();
    // The library cleared its device set during start(); the wired headset is
    // not selectable yet, so a naive request would vanish into `Log.e`.
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(true);
    await flush();

    expect(h.requests).toEqual(['WIRED_HEADSET']);
    expect(h.important).toContain('audio route request dropped');
    expect(h.applied).toEqual([]);

    // Re-applied once the device set is populated — event-driven, no delay.
    h.platformAvailable.add('WIRED_HEADSET');
    h.controller.updateDevices(['SPEAKER_PHONE', 'WIRED_HEADSET', 'EARPIECE']);
    await flush();

    expect(h.applied).toEqual(['WIRED_HEADSET']);
    expect(h.important.filter((e) => e === 'audio route request dropped')).toHaveLength(1);
  });

  it('honors the earpiece default and the speaker toggle when no headset is present', async () => {
    const h = harness();
    h.controller.start();
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(false);
    await flush();
    expect(h.applied).toEqual(['EARPIECE']);

    h.controller.setSpeakerOn(true);
    await flush();
    expect(h.applied).toEqual(['EARPIECE', 'SPEAKER_PHONE']);
  });

  it('does not gate iOS on an Android-only device-set event', async () => {
    const h = harness({ deviceSetRequired: false });
    h.controller.start();
    h.controller.resolveHeadsetSeed(false);
    await flush();

    expect(h.applied).toEqual(['EARPIECE']);
  });

  it('defers the automatic route until the Android device set is known', async () => {
    const h = harness();
    h.controller.start();
    h.controller.resolveHeadsetSeed(false);
    await flush();
    expect(h.requests).toEqual([]);

    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    await flush();
    expect(h.applied).toEqual(['EARPIECE']);
  });

  it('applies an explicit speaker toggle even before the device set is known', async () => {
    const h = harness();
    h.controller.start();
    h.controller.resolveHeadsetSeed(false);
    await flush();
    expect(h.requests).toEqual([]);

    h.controller.setSpeakerOn(true);
    await flush();
    expect(h.applied).toEqual(['SPEAKER_PHONE']);
  });

  it('re-asserts the route on connected even when it is unchanged', async () => {
    const h = harness();
    h.controller.start();
    h.controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    h.controller.resolveHeadsetSeed(false);
    await flush();
    expect(h.requests).toEqual(['EARPIECE']);

    h.controller.reassert();
    await flush();

    expect(h.requests).toEqual(['EARPIECE', 'EARPIECE']);
  });

  it('does not stack a second request while the same route is in flight', async () => {
    const requests: AudioRoute[] = [];
    let resolveFirst: ((result: RouteRequestResult) => void) | undefined;
    const first = new Promise<RouteRequestResult>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const controller = new AudioRouteController({
      initialSpeakerOn: false,
      deviceSetRequired: true,
      ports: {
        request: (route) => {
          requests.push(route);
          calls += 1;
          return calls === 1 ? first : Promise.resolve({ accepted: true });
        },
        log: () => {},
        logImportant: () => {},
      },
    });
    controller.start();
    controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    controller.resolveHeadsetSeed(false);
    await flush();
    expect(requests).toEqual(['EARPIECE']);

    // The native device-set event triggered by this request can land before
    // the request promise resolves; it must not issue a duplicate route.
    controller.updateDevices(['SPEAKER_PHONE', 'EARPIECE']);
    await flush();
    expect(requests).toEqual(['EARPIECE']);

    resolveFirst?.({ accepted: true });
    await flush();
    expect(requests).toEqual(['EARPIECE']);
  });
});