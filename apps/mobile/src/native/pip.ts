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
};
