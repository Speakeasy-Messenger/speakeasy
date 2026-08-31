import { describe, expect, it } from 'vitest';
import { parseNativeCallKitReport } from './callkit.js';

describe('parseNativeCallKitReport', () => {
  it('normalizes the native call_id to CallKit UUID handoff', () => {
    expect(
      parseNativeCallKitReport({
        call_id: 'call-01M1AJ1HXE7A4GPFDF0B9QNWG9',
        call_uuid: 'F5DCB01E-2619-54B4-BFC4-9F9DB17EFB32',
      }),
    ).toEqual({
      callId: 'call-01M1AJ1HXE7A4GPFDF0B9QNWG9',
      callUUID: 'f5dcb01e-2619-54b4-bfc4-9f9db17efb32',
    });
  });

  it('rejects an incomplete mapping', () => {
    expect(
      parseNativeCallKitReport({ call_uuid: 'f5dcb01e-2619-54b4-bfc4-9f9db17efb32' }),
    ).toBeUndefined();
    expect(parseNativeCallKitReport({ call_id: 'call-1' })).toBeUndefined();
  });

  it('preserves an expired UUID for explicit orphan cleanup without a call id', () => {
    expect(
      parseNativeCallKitReport({
        call_uuid: 'F5DCB01E-2619-54B4-BFC4-9F9DB17EFB32',
        expired: true,
      }),
    ).toEqual({
      callUUID: 'f5dcb01e-2619-54b4-bfc4-9f9db17efb32',
      expired: true,
    });
  });
});
