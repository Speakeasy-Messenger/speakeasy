import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the version gate without a native module. Default to a GA
// string so the "no-op on GA" case is the resting state.
vi.mock('../version.js', () => ({ appVersion: vi.fn(() => '1.0.50') }));

import { appVersion } from '../version.js';
import { uploadDiag } from './upload.js';
import { diag, __resetDiagForTests } from './log.js';
import { useSettings } from '../store/settings.js';
import type { DiagUploadPayload } from '../api/client.js';

const mockVersion = vi.mocked(appVersion);

function makeApi() {
  const uploadDiag = vi.fn(
    (_token: string, _payload: DiagUploadPayload): Promise<void> => Promise.resolve(),
  );
  return { uploadDiag };
}

const deps = (api: ReturnType<typeof makeApi>, token: string | undefined = 'dvt_test') => ({
  api,
  getDeviceToken: () => token,
});

beforeEach(() => {
  __resetDiagForTests();
  mockVersion.mockReturnValue('1.0.50'); // GA by default
  useSettings.setState({ diagStreaming: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('uploadDiag', () => {
  it('is a no-op on a GA build (version without "-rc.")', async () => {
    const api = makeApi();
    await uploadDiag({ reason: 'manual' }, deps(api));
    expect(api.uploadDiag).not.toHaveBeenCalled();
  });

  it('is a no-op on beta when the diagStreaming toggle is off', async () => {
    mockVersion.mockReturnValue('1.0.50-rc.7');
    useSettings.setState({ diagStreaming: false });
    const api = makeApi();
    await uploadDiag({ reason: 'manual' }, deps(api));
    expect(api.uploadDiag).not.toHaveBeenCalled();
  });

  it('is a no-op on beta with no device token (pre-enrollment)', async () => {
    mockVersion.mockReturnValue('1.0.50-rc.7');
    const api = makeApi();
    await uploadDiag({ reason: 'manual' }, { api, getDeviceToken: () => undefined });
    expect(api.uploadDiag).not.toHaveBeenCalled();
  });

  it('uploads on a beta build with the toggle on, forwarding callId + version', async () => {
    mockVersion.mockReturnValue('1.0.50-rc.7');
    diag('call', 'startOutgoing', { callId: 'c1' });
    const api = makeApi();
    await uploadDiag({ reason: 'call_failed', callId: 'c1' }, deps(api));
    expect(api.uploadDiag).toHaveBeenCalledTimes(1);
    const [token, payload] = api.uploadDiag.mock.calls[0]!;
    expect(token).toBe('dvt_test');
    expect(payload).toBeDefined();
    expect(payload.appVersion).toBe('1.0.50-rc.7');
    expect(payload.reason).toBe('call_failed');
    expect(payload.callId).toBe('c1');
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.at(-1)?.tag).toBe('call');
  });

  it('omits callId when none is given (crash / manual)', async () => {
    mockVersion.mockReturnValue('1.0.50-rc.7');
    const api = makeApi();
    await uploadDiag({ reason: 'crash' }, deps(api));
    expect(api.uploadDiag).toHaveBeenCalledTimes(1);
    expect(api.uploadDiag.mock.calls[0]![1].callId).toBeUndefined();
  });

  it('never throws when the upload rejects (fire-and-forget)', async () => {
    mockVersion.mockReturnValue('1.0.50-rc.7');
    const api = { uploadDiag: vi.fn(async () => { throw new Error('network'); }) };
    await expect(uploadDiag({ reason: 'manual' }, deps(api))).resolves.toBeUndefined();
  });
});
