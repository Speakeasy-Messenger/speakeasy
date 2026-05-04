/**
 * JS-side crash capture for alpha builds.
 *
 * The native crash writer in MainApplication.kt only catches uncaught
 * Java/Kotlin throwables — it does NOT see RN/JS exceptions or
 * unhandled promise rejections, which are the most common cause of
 * release-mode crashes for an RN app. This module hooks the JS-side
 * global error handler and persists the failing error + a snapshot
 * of the diag buffer to AsyncStorage so the next launch's
 * DiagnosticsScreen can render it.
 *
 * Persistence is best-effort. AsyncStorage's setItem completes async
 * but typically within a few ms, well before RN's default global
 * handler tears down the process.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatDiag, getDiagSnapshot } from './log.js';

export const LAST_JS_CRASH_KEY = '@speakeasy/lastJsCrash';

export interface CapturedCrash {
  capturedAt: string;
  isFatal: boolean;
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  /** Pre-formatted diag log up to the moment of crash. */
  diagLog: string;
}

interface ErrorUtilsApi {
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
  getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
}

function snapshot(error: Error, isFatal: boolean | undefined): CapturedCrash {
  return {
    capturedAt: new Date().toISOString(),
    isFatal: !!isFatal,
    errorName: error?.name ?? 'Error',
    errorMessage: error?.message ?? String(error),
    errorStack: error?.stack,
    diagLog: formatDiag(getDiagSnapshot()),
  };
}

let installed = false;

export function installErrorHandler(): void {
  if (installed) return;
  installed = true;

  const eu = (globalThis as { ErrorUtils?: ErrorUtilsApi }).ErrorUtils;
  if (!eu) return;
  const previous = eu.getGlobalHandler();

  eu.setGlobalHandler((error, isFatal) => {
    try {
      const captured = snapshot(error, isFatal);
      // Best-effort: AsyncStorage is async, but the native bridge is
      // very fast and almost always completes before the process dies.
      void AsyncStorage.setItem(LAST_JS_CRASH_KEY, JSON.stringify(captured));
    } catch {
      // Never let our reporter swallow the original crash.
    }
    previous(error, isFatal);
  });
}

export async function readLastJsCrash(): Promise<CapturedCrash | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_JS_CRASH_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CapturedCrash;
  } catch {
    return null;
  }
}

export async function clearLastJsCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_JS_CRASH_KEY);
  } catch {
    // best effort
  }
}
