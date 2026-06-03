import { describe, expect, it } from 'vitest';
import type { PermissionResult } from './runtime.js';
import { coalescePermissionRequest } from './runtime.js';

/**
 * Regression for the silent dead-call accept: on a permission-cold device
 * the ring-time warm-up and accept()'s getUserMedia both call
 * ensureMicPermission(), firing two overlapping PermissionsAndroid.request()
 * calls for RECORD_AUDIO. RN keeps a single pending-callback slot per
 * permission, so one promise hangs forever and the call never answers.
 * coalescePermissionRequest dedupes the in-flight request.
 */
describe('coalescePermissionRequest', () => {
  it('joins an in-flight request instead of firing a second prompt', async () => {
    let calls = 0;
    let resolve!: (v: PermissionResult) => void;
    const doRequest = (): Promise<PermissionResult> => {
      calls += 1;
      return new Promise<PermissionResult>((r) => {
        resolve = r;
      });
    };

    const warmUp = coalescePermissionRequest('android.permission.RECORD_AUDIO', doRequest);
    const accept = coalescePermissionRequest('android.permission.RECORD_AUDIO', doRequest);

    // The second caller shares the first request rather than firing its own.
    expect(calls).toBe(1);

    resolve('granted');
    await expect(warmUp).resolves.toBe('granted');
    await expect(accept).resolves.toBe('granted'); // would hang forever without the dedupe
  });

  it('clears the in-flight entry so a later request can run', async () => {
    let calls = 0;
    const doRequest = (): Promise<PermissionResult> => {
      calls += 1;
      return Promise.resolve('granted');
    };

    await coalescePermissionRequest('android.permission.RECORD_AUDIO', doRequest);
    await coalescePermissionRequest('android.permission.RECORD_AUDIO', doRequest);

    expect(calls).toBe(2);
  });

  it('also clears the entry when the request rejects', async () => {
    await expect(
      coalescePermissionRequest('android.permission.RECORD_AUDIO', () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    // A fresh request after a rejection is not blocked by a stale entry.
    let calls = 0;
    await coalescePermissionRequest('android.permission.RECORD_AUDIO', () => {
      calls += 1;
      return Promise.resolve('granted');
    });
    expect(calls).toBe(1);
  });

  it('keys by permission — different perms do not share a request', () => {
    let micCalls = 0;
    let camCalls = 0;
    coalescePermissionRequest('android.permission.RECORD_AUDIO', () => {
      micCalls += 1;
      return new Promise<PermissionResult>(() => {}); // never resolves
    });
    coalescePermissionRequest('android.permission.CAMERA', () => {
      camCalls += 1;
      return new Promise<PermissionResult>(() => {});
    });
    expect(micCalls).toBe(1);
    expect(camCalls).toBe(1);
  });
});
