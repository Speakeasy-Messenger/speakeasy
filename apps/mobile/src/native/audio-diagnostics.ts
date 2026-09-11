import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { diag, diagImportant } from '../diag/log.js';

interface NativeAudioDiagnostics {
  setCallId(callId: string | null): void;
  drain(): Promise<unknown[]>;
  snapshot(trigger: string): Promise<Record<string, unknown>>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const native = (NativeModules as { SpeakeasyAudioDiagnostics?: NativeAudioDiagnostics })
  .SpeakeasyAudioDiagnostics;

function record(value: unknown): void {
  if (!value || typeof value !== 'object') {
    diagImportant('native-audio', 'malformed native event', { valueType: typeof value });
    return;
  }
  const event = value as Record<string, unknown>;
  const important = event.important === true || String(event.event ?? '').includes('error');
  const message = typeof event.event === 'string' ? event.event : 'snapshot';
  if (important) diagImportant('native-audio', message, event);
  else diag('native-audio', message, event);
}

export const audioDiagnostics = {
  start(callId: string): () => void {
    const subscriptions: Array<{ remove(): void }> = [];
    if (Platform.OS === 'android') {
      native?.setCallId(callId);
      if (native) {
        const emitter = new NativeEventEmitter(native as unknown as never);
        subscriptions.push(emitter.addListener('SpeakeasyAudioDiagnostics', record));
        void native.drain().then((entries) => entries.forEach(record)).catch((err) => {
          diagImportant('native-audio', 'native drain failed', { callId, err: String(err) });
        });
      }
      subscriptions.push(DeviceEventEmitter.addListener('SpeakeasyAudioFocusDiagnostics', record));
      void this.snapshot(callId, 'peer-created');
    }
    return () => subscriptions.forEach((subscription) => subscription.remove());
  },

  async snapshot(callId: string, trigger: string): Promise<void> {
    if (Platform.OS !== 'android' || !native) return;
    try {
      record({ callId, trigger, ...(await native.snapshot(trigger)) });
    } catch (err) {
      diagImportant('native-audio', 'native snapshot failed', { callId, trigger, err: String(err) });
    }
  },

  stop(callId: string): void {
    if (Platform.OS !== 'android' || !native) return;
    void this.snapshot(callId, 'peer-closed').finally(() => native.setCallId(null));
  },
};
