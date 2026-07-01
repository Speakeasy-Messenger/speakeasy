import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * Android Picture-in-Picture bridge for video calls. iOS PiP is handled
 * declaratively by the `iosPIP` prop on RTCView (see VideoCallScreen); this
 * module is the Android counterpart — it tells the native MainActivity that a
 * video call is on screen so pressing Home floats the call into a PiP window,
 * and surfaces the resulting PiP-mode changes back to JS.
 */
interface NativePip {
  setVideoCallActive(active: boolean): void;
}

const native = (NativeModules as { SpeakeasyPip?: NativePip }).SpeakeasyPip;

export const pip = {
  /** Mark a video call as on-screen (Android only). Safe no-op elsewhere. */
  setVideoCallActive(active: boolean): void {
    if (Platform.OS !== 'android') return;
    native?.setVideoCallActive(active);
  },

  /**
   * Subscribe to Android PiP-mode changes so the UI can collapse to just the
   * video while floating. Returns an unsubscribe fn; no-op on non-Android.
   */
  onPipModeChanged(cb: (inPip: boolean) => void): () => void {
    if (Platform.OS !== 'android' || !native) return () => {};
    const emitter = new NativeEventEmitter(native as unknown as never);
    const sub = emitter.addListener('SpeakeasyPipModeChanged', (inPip: boolean) =>
      cb(!!inPip),
    );
    return () => sub.remove();
  },

  /**
   * Subscribe to the Android PiP window being DISMISSED (the user closed the
   * bubble rather than expanding it back into the app). The call must end on
   * this — otherwise the camera/mic/ring keep running headless. Returns an
   * unsubscribe fn; no-op on non-Android.
   */
  onPipClosed(cb: () => void): () => void {
    if (Platform.OS !== 'android' || !native) return () => {};
    const emitter = new NativeEventEmitter(native as unknown as never);
    const sub = emitter.addListener('SpeakeasyPipClosed', () => cb());
    return () => sub.remove();
  },

  /**
   * Subscribe to the authoritative PiP window size (in dp = RN layout units),
   * pushed by native on PiP enter AND on every bubble resize. This is ground
   * truth — RN's own onLayout frequently reports a stale size inside a PiP
   * window, which left the video SurfaceView holding its pre-resize buffer
   * (the "video only fills a corner / lags resizing" reports). Keying the
   * compact RTCView on this size recreates the surface at the true bubble size.
   * Returns an unsubscribe fn; no-op on non-Android.
   */
  onPipResize(cb: (size: { width: number; height: number }) => void): () => void {
    if (Platform.OS !== 'android' || !native) return () => {};
    const emitter = new NativeEventEmitter(native as unknown as never);
    const sub = emitter.addListener(
      'SpeakeasyPipResize',
      (size: { width: number; height: number }) => cb(size),
    );
    return () => sub.remove();
  },

  /**
   * Native PiP-lifecycle breadcrumbs (onStop flag values) — diagnostic only, so
   * a device log shows why an X-dismiss did or didn't end the call. No-op off
   * Android.
   */
  onPipLifecycle(cb: (info: string) => void): () => void {
    if (Platform.OS !== 'android' || !native) return () => {};
    const emitter = new NativeEventEmitter(native as unknown as never);
    const sub = emitter.addListener('SpeakeasyPipLifecycle', (info: string) => cb(info));
    return () => sub.remove();
  },
};
