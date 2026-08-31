import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export interface NativeCallKitReport {
  callId?: string;
  callUUID: string;
  expired?: boolean;
  reportCompleted?: boolean;
  reportedAtMs?: number;
}

export interface NativeCallKitReportSource {
  drain(): Promise<NativeCallKitReport[]>;
  subscribe(listener: (report: NativeCallKitReport) => void): () => void;
  end(callUUID: string): boolean;
  acknowledge(callUUID: string): void;
}

interface NativeCallKitHandoff {
  consumePendingCallKitReports(): Promise<unknown>;
  endPendingCallKitReport(callUUID: string): void;
  acknowledgePendingCallKitReport(callUUID: string): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const native = (NativeModules as { SpeakeasyNativeDiagnostics?: NativeCallKitHandoff })
  .SpeakeasyNativeDiagnostics;

/** Normalize the native dictionary without trusting arbitrary bridge values. */
export function parseNativeCallKitReport(value: unknown): NativeCallKitReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as {
    call_id?: unknown;
    call_uuid?: unknown;
    expired?: unknown;
    report_completed?: unknown;
    at?: unknown;
  };
  if (typeof raw.call_uuid !== 'string' || raw.call_uuid.length === 0) return undefined;
  const callId =
    typeof raw.call_id === 'string' && raw.call_id.length > 0 ? raw.call_id : undefined;
  const expired = raw.expired === true;
  const reportCompleted = raw.report_completed === true;
  const reportedAtMs = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
  if (!callId && !expired) return undefined;
  return {
    ...(callId ? { callId } : {}),
    callUUID: raw.call_uuid.toLowerCase(),
    ...(expired ? { expired: true } : {}),
    ...(reportCompleted ? { reportCompleted: true } : {}),
    ...(reportedAtMs !== undefined ? { reportedAtMs } : {}),
  };
}

/**
 * AppDelegate persists this handoff before it reports the PushKit call to
 * CallKit. The event is the warm-app fast path; drain() is the killed/suspended
 * fallback. Together they make the native call_id <-> UUID mapping available
 * without depending on react-native-callkeep preserving its nested payload.
 */
export const nativeCallKitReports: NativeCallKitReportSource = {
  async drain(): Promise<NativeCallKitReport[]> {
    if (Platform.OS !== 'ios' || !native?.consumePendingCallKitReports) return [];
    const raw = await native.consumePendingCallKitReports();
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      const report = parseNativeCallKitReport(entry);
      return report ? [report] : [];
    });
  },

  subscribe(listener: (report: NativeCallKitReport) => void): () => void {
    if (Platform.OS !== 'ios' || !native) return () => {};
    const emitter = new NativeEventEmitter(native as unknown as never);
    const subscription = emitter.addListener('SpeakeasyCallKitReported', (value: unknown) => {
      const report = parseNativeCallKitReport(value);
      if (report) listener(report);
    });
    return () => subscription.remove();
  },

  end(callUUID: string): boolean {
    if (Platform.OS !== 'ios' || !native?.endPendingCallKitReport) return false;
    native.endPendingCallKitReport(callUUID);
    return true;
  },

  acknowledge(callUUID: string): void {
    if (Platform.OS !== 'ios' || !native?.acknowledgePendingCallKitReport) return;
    native.acknowledgePendingCallKitReport(callUUID);
  },
};
