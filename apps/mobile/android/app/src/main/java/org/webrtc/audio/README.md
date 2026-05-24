# Speakeasy fork of `org.webrtc.audio`

These 8 files are a verbatim copy of upstream WebRTC M124's
`sdk/android/{api,src/java}/org/webrtc/audio/` (BSD-3 licensed), with
**one** localized modification to wire the Phase 5j Private Call
voice filter into the capture path.

## Why the fork exists

Upstream's `JavaAudioDeviceModule` has no sample-modifying hook
between `AudioRecord.read()` and `nativeDataIsRecorded()`. The
public `SamplesReadyCallback` fires AFTER samples are pushed to the
C++ engine — observation only, no filtering. The `nativeAudioRecord`
native pointer is captured during `nativeCreateAudioDeviceModule` and
points into the Java `WebRtcAudioRecord` instance, so we can't swap
the AudioRecord via reflection after construction without breaking
the JNI binding.

Forking the audio classes is the cleanest path. The native libwebrtc
.so calls into Java by class name (`org/webrtc/audio/WebRtcAudioRecord`),
so our forks must live in that package and keep the same signatures
for the methods C++ calls.

## How the shadow works

Both this project's compiled classes AND the upstream WebRTC jar
end up in the merged APK with the same fully-qualified class name.
At runtime, Android's `PathClassLoader` iterates dex files in
numeric order (`classes.dex` → `classes2.dex` → ...) and returns the
first match. AGP groups **project sources into earlier dex files
than library dependencies**, so our `org.webrtc.audio.WebRtcAudioRecord`
is found first and the upstream one is shadowed.

We've verified the shadowing with `dexdump -h` on a debug APK build:
- classes26.dex contains our `WebRtcAudioRecord$AudioRecordThread`
  with the `ActiveFilterHolder` reference (the hook).
- classes30.dex contains upstream's same-named class without the
  reference. Never loaded by the classloader.

This is documented Android behavior (`PathClassLoader` semantics +
multidex spec) — but it depends on AGP's dex-grouping heuristic,
which has been stable since the dex-archive build pipeline landed
in AGP 4.x. If a future AGP release reorders, the unit test for
[`isPrivateCallAvailable`](../voicefilter/VoiceFilterModule.kt)
will still pass (the BuildConfig.DEBUG gate doesn't care which
WebRtcAudioRecord loads), but voice filtering would silently fall
off. **The integration smoke test is to install a debug APK and
make a Private Call — if the filter doesn't audibly mask the voice,
re-check `dexdump`.**

## The one modification

`WebRtcAudioRecord.AudioRecordThread.run()` was changed in exactly
one spot. Search for `SPEAKEASY FORK` — the inserted block sits
between the existing `microphoneMute` branch and the existing
`nativeDataIsRecorded` push. It:

1. Reads the active filter from `ActiveFilterHolder` (a process-wide
   singleton owned by `VoiceFilterModule`).
2. If non-null, calls `filter.process(byteBuffer, sampleRate, channels)`
   in place on the same direct ByteBuffer the native ADM reads from.
3. On `process()` returning false (latency tripped, RuntimeException,
   etc.), mutes the mic — failure-closed brand promise: never send
   unfiltered audio when the filter was meant to be active.

Nothing else changed.

## Upgrading

When react-native-webrtc bumps libwebrtc to a new milestone (M125+),
re-download the matching source from chromium.googlesource.com
(`branch-heads/<chromium-milestone-number>`), diff against these
files, and reapply the `SPEAKEASY FORK` marker in `WebRtcAudioRecord.java`.

```sh
# Example: refresh from M124 (chromium 6367)
for f in WebRtcAudioRecord JavaAudioDeviceModule WebRtcAudioTrack \
         WebRtcAudioEffects WebRtcAudioManager WebRtcAudioUtils \
         LowLatencyAudioBufferManager VolumeLogger; do
  for dir in src/java/org/webrtc/audio api/org/webrtc/audio; do
    curl -fsSL "https://chromium.googlesource.com/external/webrtc/+/branch-heads/6367/sdk/android/${dir}/${f}.java?format=TEXT" \
      | base64 -d > "${f}.java.new" && [ -s "${f}.java.new" ] && \
      head -1 "${f}.java.new" | grep -q Copyright && \
      mv "${f}.java.new" "${f}.java" && echo "got $f from $dir" && break
  done
done
```

After overwriting, reapply the `SPEAKEASY FORK` hook in
`WebRtcAudioRecord.java` (between the `microphoneMute` branch and
the `nativeDataIsRecorded` call) and add the two imports:

```java
import xyz.speakeasyapp.app.voicefilter.ActiveFilterHolder;
import xyz.speakeasyapp.app.voicefilter.SampleFilter;
```

Then rebuild and verify with `dexdump | grep ActiveFilterHolder` on
the debug APK.
