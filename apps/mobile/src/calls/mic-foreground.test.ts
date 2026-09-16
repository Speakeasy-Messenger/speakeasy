import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

/**
 * Unit tests for the mic-foreground-service capture gate.
 *
 * Regression context (call-01M2N41QF1P7BE6HSWR152SMRG, diag build
 * v1.0.74-rc.2): AudioRecord capture started while the app was BACKGROUNDED
 * with NO microphone foreground service (microphoneForegroundService:false)
 * — Android 14+ handed the call a permanently-muted capture stream
 * (peak:0/rms:0 for the whole call). The gate must start the mic FGS and
 * CONFIRM it active before resolving, and refuse otherwise.
 */
vi.mock('./call-notification.js', () => ({
  showOngoingCallNotification: vi.fn(async () => undefined),
}));
vi.mock('../native/audio-diagnostics.js', () => ({
  audioDiagnostics: {
    isMicrophoneForegroundServiceActive: vi.fn(async () => true),
  },
}));
vi.mock('../diag/log.js', () => ({ diag: vi.fn(), diagImportant: vi.fn() }));

import { showOngoingCallNotification } from './call-notification.js';
import { audioDiagnostics } from '../native/audio-diagnostics.js';
import {
  MIC_FGS_CONFIRM_TIMEOUT_MS,
  MIC_FGS_MIN_API_LEVEL,
  MIC_FGS_POLL_INTERVAL_MS,
  ensureMicForegroundService,
} from './mic-foreground.js';

const mockShow = vi.mocked(showOngoingCallNotification);
const mockCheck = vi.mocked(audioDiagnostics.isMicrophoneForegroundServiceActive);

const call = { callId: 'call-test', peerUserId: 'bob', kind: 'audio' as const };

const platform = Platform as { OS: string; Version?: number };

describe('ensureMicForegroundService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockShow.mockClear();
    mockCheck.mockClear();
    mockShow.mockResolvedValue(undefined);
    mockCheck.mockResolvedValue(true);
    platform.OS = 'android';
    platform.Version = MIC_FGS_MIN_API_LEVEL;
  });
  afterEach(() => {
    vi.useRealTimers();
    platform.OS = 'android';
    delete platform.Version;
  });

  it('starts the pill FGS and resolves true once the microphone FGS is confirmed active', async () => {
    const result = await ensureMicForegroundService(call);
    expect(mockShow).toHaveBeenCalledWith({
      peerHandle: 'bob',
      micMuted: false,
      kind: 'audio',
    });
    expect(mockCheck).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('passes the call kind through (video calls need the mic FGS too)', async () => {
    await ensureMicForegroundService({ ...call, kind: 'video' });
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video' }),
    );
  });

  it('resolves false when the FGS start throws (e.g. Android 14 background start rejection)', async () => {
    mockShow.mockRejectedValue(new Error('ForegroundServiceStartNotAllowedException'));
    const result = await ensureMicForegroundService(call);
    expect(result).toBe(false);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('polls until confirmation, then resolves true', async () => {
    mockCheck.mockReset();
    mockCheck.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const pending = ensureMicForegroundService(call);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe(true);
    expect(mockCheck.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves false when the FGS never confirms within the deadline — capture stays closed', async () => {
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(false);
    const pending = ensureMicForegroundService(call);
    await vi.advanceTimersByTimeAsync(MIC_FGS_CONFIRM_TIMEOUT_MS + MIC_FGS_POLL_INTERVAL_MS);
    expect(await pending).toBe(false);
    // It kept trying for the whole window, not just once.
    expect(mockCheck.mock.calls.length).toBeGreaterThan(2);
  });

  it('treats a null native answer (no native module) as not confirmed', async () => {
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(null);
    const pending = ensureMicForegroundService(call);
    await vi.advanceTimersByTimeAsync(MIC_FGS_CONFIRM_TIMEOUT_MS + MIC_FGS_POLL_INTERVAL_MS);
    expect(await pending).toBe(false);
  });

  it('is a no-op pass-through on non-Android (CallKit owns the audio session)', async () => {
    platform.OS = 'ios';
    const result = await ensureMicForegroundService(call);
    expect(result).toBe(true);
    expect(mockShow).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  /**
   * minSdk is 28. The `microphone` FGS type — and the while-in-use capture
   * muting it exists to satisfy — only arrived in API 30, so below that the
   * native check can only ever answer null. Requiring confirmation there
   * timed out the full deadline and failed 100% of calls on API 28/29.
   */
  it('starts the pill but skips confirmation below the mic-FGS API level', async () => {
    platform.Version = MIC_FGS_MIN_API_LEVEL - 1;
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(null);
    const result = await ensureMicForegroundService(call);
    expect(result).toBe(true);
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('does not fail the call below the mic-FGS API level when the pill start throws', async () => {
    platform.Version = MIC_FGS_MIN_API_LEVEL - 1;
    mockShow.mockRejectedValue(new Error('no notification channel'));
    expect(await ensureMicForegroundService(call)).toBe(true);
  });

  it('still requires confirmation when the API level is unknown (fail closed)', async () => {
    delete platform.Version;
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(false);
    const pending = ensureMicForegroundService(call);
    await vi.advanceTimersByTimeAsync(MIC_FGS_CONFIRM_TIMEOUT_MS + MIC_FGS_POLL_INTERVAL_MS);
    expect(await pending).toBe(false);
  });
});
