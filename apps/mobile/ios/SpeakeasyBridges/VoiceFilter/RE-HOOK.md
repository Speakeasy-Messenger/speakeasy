# iOS voice-mask re-hook plan

**Status:** iOS voice masking is OFF and fail-safed. Private calls are hidden on
iOS (`VoiceFilterModule.swift` reports `isAvailable:false`; the JS shim
`decidePrivateCallAvailable` also returns false for `os === 'ios'`). This doc is
the plan to turn it back on safely.

## How we got here

The iOS mask only ever ran inside **`SpeakeasyAudioDevice`** — a custom
`RTCAudioDevice` we installed via `WebRTCModuleOptions.audioDevice` in
`AppDelegate.mm`. It read `ActiveFilterHolder` on every captured frame and
mutated the PCM16 in place before handing it to WebRTC.

That custom ADM **broke all call audio** (no/garbled voice on voice *and* video
calls). Build 13 fixed calls by reverting to the **stock WebRTC ADM**
(`AppDelegate.mm` commented out the `audioDevice` install). Masking died with
it: `wrapTrack` still fills `ActiveFilterHolder`, but nothing reads it, so a
Private call would transmit the **real, unmasked voice**. We now hide the option
rather than ship that leak.

## Why this is the hard one

`react-native-webrtc@124` exposes exactly **one** audio seam:
`WebRTCModuleOptions.audioDevice` (a full `RTCAudioDevice`). The factory is built
`initWithEncoderFactory:decoderFactory:audioDevice:` — there is **no**
`audioProcessingModule` / capture-post-processor parameter. The WebRTC binary is
**JitsiWebRTC ~> 124**, which does not expose `RTCAudioCustomProcessingDelegate`.

So unlike Android — where we keep the stock pipeline and fork only
`WebRtcAudioRecord` to inject the DSP at the capture buffer — iOS has **no
in-pipeline capture hook**. The only lever is replacing the whole ADM, which is
what broke calls.

## Options (ranked)

### Option A — Fix & re-enable `SpeakeasyAudioDevice` (the custom ADM)
Re-install the ADM in `AppDelegate.mm`, but only after the audio-correctness
bugs that broke calls are actually fixed. Known prior fixes already in the file:
- `installTapOnBus` crash: validate format + `setActive` + bounded retry.
- playout render-thread malloc removed (reusable grow-only `playoutScratch`).

What still needs proving on a **real device + live peer** (cannot be done in a
simulator or this harness):
- Full-duplex audio actually flows (the original failure mode).
- Sample-rate / channel / format negotiation matches the route (speaker,
  receiver, Bluetooth, CarPlay) and survives route changes.
- AVAudioSession category/mode interplay with CallKit + the stock path.
- Latency budget (the DSP adds frames; `latency_exceeded` must fail closed).
- Failure-closed mute on DSP error never leaks raw audio.

**Risk:** high (this is the exact code that broke calls). **Effort:** medium.
**Verifiability here:** compile-only on the Mac; correctness needs a device.

### Option B — Patch the pod to add an audio-processing module
`patch-package` react-native-webrtc to build the factory with an
`RTCDefaultAudioProcessingModule` whose `capturePostProcessingDelegate` runs the
DSP. **Blocked:** JitsiWebRTC 124 doesn't ship `RTCAudioCustomProcessingDelegate`.
Would require swapping the WebRTC binary for one that does (e.g. the
livekit/WebRTC-SDK build) — a large, risky dependency change touching every
call. **Not recommended now.**

### Option C — Stay fail-safed on iOS
Ship with Private calls iOS-off (current state). Android keeps full masking via
its capture fork. Revisit A when a device is available to verify.

## Recommendation

Hold at **C** until there is an iOS device for a live two-party call test, then
do **A** behind that verification. Do **not** flip `isAvailable` back to true (in
either `VoiceFilterModule.swift` or `decidePrivateCallAvailable`) until masked
audio is confirmed on-device with a real peer — re-enabling blind risks
re-shipping the build-<13 call-audio breakage.

## The flip checklist (when A is verified)

1. `AppDelegate.mm`: re-install `rtcOptions.audioDevice = [[SpeakeasyAudioDevice alloc] init];`
2. `VoiceFilterModule.swift`: `constantsToExport` → `isAvailable: true`.
3. `voice-filter.ts`: remove the `if (os === 'ios') return false` fail-safe in
   `decidePrivateCallAvailable` (and update its test).
4. Device test: 1:1 + group, voice + video, each profile (Smoke/Velvet/Glass),
   route changes, mid-call mask toggle (`setBypass`), and a forced DSP failure
   to confirm the mute-on-fail leak guard.
