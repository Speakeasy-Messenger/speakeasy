/**
 * Headset-aware audio route selection for `WebRtcCallPeer`.
 *
 * Why this is a separate, injectable unit: the Android call-audio failure
 * "headphones connected before the call are silent, but headphones plugged
 * in mid-call work" was only reproducible on a physical device, and the
 * routing branch had zero automated coverage. Pulling the decision out of
 * `webrtc-peer.ts` lets `audio-route.test.ts` reproduce the sequence with a
 * fake platform.
 *
 * The failure it fixes (see upstream
 * react-native-webrtc/react-native-incall-manager#138): the old
 * `ensureManager()` seeded the headset state from an async
 * `getIsWiredHeadsetPluggedIn()` query, but applied the first route on the
 * very next line. That first route therefore always saw `headsetPlugged =
 * false`, forced the earpiece, and pinned InCallManager's
 * `userSelectedAudioDevice` to `EARPIECE` — which its `getPreferredAudioDevice`
 * checks before `WIRED_HEADSET` and `BLUETOOTH`. Plugging in afterwards fired
 * a `WiredHeadset` event that corrected the state, which is why only
 * "connected before the call" broke.
 *
 * The controller therefore:
 *   - refuses to pick a route until the headset query has resolved (and, on
 *     Android, until the native audio-device set is known), so the earpiece is
 *     never forced while a headset is present;
 *   - treats every headset-type route the platform reports (`WIRED_HEADSET`,
 *     which the native patch widens to include `TYPE_USB_HEADSET`, and
 *     `BLUETOOTH`) as a headset and routes to it;
 *   - reports a rejected route request through `logImportant` instead of
 *     letting the platform drop it silently, and retries it when the device
 *     set changes rather than after a guessed delay.
 */

/** Routes the app can request from InCallManager. */
export type AudioRoute = 'BLUETOOTH' | 'WIRED_HEADSET' | 'SPEAKER_PHONE' | 'EARPIECE';

export interface RouteRequestResult {
  /**
   * Whether the platform accepted the request as selectable. On Android this
   * is native `selectAudioDevice()`'s availability check; a headset route can
   * be rejected while the library is still repopulating its device set.
   */
  accepted: boolean;
}

export interface AudioRoutePorts {
  /** Ask the platform to switch to `route`. Must not throw for a normal reject. */
  request(route: AudioRoute): Promise<RouteRequestResult>;
  log(event: string, data?: Record<string, unknown>): void;
  logImportant(event: string, data?: Record<string, unknown>): void;
}

export interface AudioRouteControllerOptions {
  /** `speakerOn` default; mirrors the orchestrator's video→speaker default. */
  initialSpeakerOn: boolean;
  /**
   * Whether the platform exposes an audio-device-set event the controller
   * must wait for before its first route. Android does; iOS does not.
   */
  deviceSetRequired: boolean;
  ports: AudioRoutePorts;
}

export class AudioRouteController {
  private speakerOn: boolean;
  /**
   * Set once the user explicitly requests the speaker. Native InCallManager
   * pins `userSelectedAudioDevice`, which its `getPreferredAudioDevice`
   * checks BEFORE Bluetooth — an explicit speaker tap must likewise outrank a
   * connected headset until the user turns the speaker off.
   */
  private speakerForced = false;
  private headsetPlugged = false;
  private seedResolved = false;
  private devicesKnown = false;
  private available = new Set<string>();
  private started = false;
  private lastAccepted?: AudioRoute;
  /**
   * Route with a request currently in flight. The native device-set event our
   * own request triggers can reach JS before the route promise resolves, so
   * without this a same-route reissue would stack (and could loop).
   */
  private inFlight?: AudioRoute;
  /** Monotonic request id so a superseded in-flight request cannot win. */
  private requestSeq = 0;
  /** Bumped on every native device-set update, to detect updates mid-request. */
  private deviceSetVersion = 0;
  /** A `reassert()` that arrived while a request was in flight. */
  private pendingReassert = false;

  constructor(private readonly options: AudioRouteControllerOptions) {
    this.speakerOn = options.initialSpeakerOn;
  }

  get currentSpeakerOn(): boolean {
    return this.speakerOn;
  }

  get isHeadsetPlugged(): boolean {
    return this.headsetPlugged;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.maybeApply();
  }

  stop(): void {
    this.started = false;
    this.inFlight = undefined;
    this.pendingReassert = false;
    // Bump the sequence so an in-flight request resolving after close cannot
    // mark a route as applied.
    this.requestSeq += 1;
  }

  setSpeakerOn(on: boolean): void {
    this.speakerOn = on;
    this.speakerForced = on;
    // Explicit user intent must not be blocked by the "state unknown"
    // deferral; only the automatic default route waits.
    this.maybeApply(true);
  }

  /**
   * The answer to the startup `getIsWiredHeadsetPluggedIn()` query. Until this
   * lands the controller does not route at all — that is the whole fix.
   */
  resolveHeadsetSeed(plugged: boolean): void {
    this.headsetPlugged = plugged;
    this.seedResolved = true;
    this.maybeApply();
  }

  /** The query failed; stop deferring but do not claim a headset is present. */
  failHeadsetSeed(): void {
    this.seedResolved = true;
    this.maybeApply();
  }

  /** A live `WiredHeadset` plug/unplug event. */
  updateHeadset(plugged: boolean): void {
    if (plugged === this.headsetPlugged) return;
    this.headsetPlugged = plugged;
    this.options.ports.log('WiredHeadset event', { plugged });
    this.maybeApply();
  }

  /**
   * The native audio-device set changed (Android `onAudioDeviceChanged`).
   * This is what unblocks the first route and what retries a request the
   * platform dropped in its clear/repopulate window.
   */
  updateDevices(devices: Iterable<string>): void {
    this.devicesKnown = true;
    this.available = new Set(devices);
    this.deviceSetVersion += 1;
    this.maybeApply();
  }

  /**
   * Re-apply the desired route on `connected`. The original code did this so
   * that a route set during `InCallManager.start()` would re-engage the
   * capture path; preserve that even when the desired route is unchanged.
   */
  reassert(): void {
    if (!this.started) return;
    this.lastAccepted = undefined;
    this.maybeApply(true);
  }

  private maybeApply(force = false): void {
    if (!this.started) return;
    const reason = force
      ? undefined
      : !this.seedResolved
        ? 'headset state unknown'
        : this.options.deviceSetRequired && !this.devicesKnown
          ? 'audio device set unknown'
          : undefined;
    if (reason) {
      this.options.ports.log('audio route deferred', { reason });
      return;
    }

    const desired = this.preferredRoute();
    if (desired === this.lastAccepted) return;
    if (desired === this.inFlight) {
      if (force) this.pendingReassert = true;
      return;
    }

    const seq = ++this.requestSeq;
    this.inFlight = desired;
    const versionAtRequest = this.deviceSetVersion;
    const available = [...this.available];
    this.options.ports.log('audio route request', {
      desired,
      available,
      headsetPlugged: this.headsetPlugged,
    });
    void this.options.ports
      .request(desired)
      .then((result) => {
        if (seq !== this.requestSeq) return; // superseded by a newer request
        this.inFlight = undefined;
        if (result.accepted) {
          this.lastAccepted = desired;
          this.options.ports.log('audio route applied', { route: desired });
        } else {
          this.lastAccepted = undefined;
          // Observable, not a log line buried inside the native library.
          this.options.ports.logImportant('audio route request dropped', {
            route: desired,
            available,
          });
          // The device set may have been repopulated while this request was in
          // flight. If so, retry now that the route may be selectable; a
          // later device-set change would otherwise have been swallowed by the
          // in-flight guard and the route would never recover.
          if (versionAtRequest !== this.deviceSetVersion) {
            this.maybeApply();
          }
        }
        this.flushPendingReassert();
      })
      .catch((err: unknown) => {
        if (seq !== this.requestSeq) return;
        this.inFlight = undefined;
        this.lastAccepted = undefined;
        this.options.ports.log('audio route request failed', {
          route: desired,
          err: String(err),
        });
        this.flushPendingReassert();
      });
  }

  /**
   * A `reassert()` that landed while a request was in flight was recorded
   * rather than dropped; reissue it now that the request has settled.
   */
  private flushPendingReassert(): void {
    if (!this.pendingReassert) return;
    this.pendingReassert = false;
    this.lastAccepted = undefined;
    this.maybeApply(true);
  }

  /**
   * An explicit speaker request outranks everything, matching the native
   * `userSelectedAudioDevice`-first precedence in InCallManager's own
   * `getPreferredAudioDevice`. Otherwise Bluetooth first, then any wired/USB
   * headset, then the user's speaker preference.
   */
  private preferredRoute(): AudioRoute {
    if (this.speakerForced && this.speakerOn) return 'SPEAKER_PHONE';
    if (this.available.has('BLUETOOTH')) return 'BLUETOOTH';
    if (this.headsetPlugged || this.available.has('WIRED_HEADSET')) return 'WIRED_HEADSET';
    return this.speakerOn ? 'SPEAKER_PHONE' : 'EARPIECE';
  }
}