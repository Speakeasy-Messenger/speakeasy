/**
 * Shared types + error classes for the device-verification flow.
 *
 * Split out from `verify-device.ts` so the imperative store
 * (`store/verify-sheet.ts`) and the UI sheet
 * (`components/VerifyDeviceSheet.tsx`) can depend on these without
 * pulling in the full Vouchflow client surface.
 */

export type VerificationReason =
  | 'launch_refresh'
  | 'websocket_auth_failed'
  | 'missing_token'
  | 'send_message'
  | 'group_action';

export class DeviceVerificationRequiredError extends Error {
  constructor(message = 'Device verification is required') {
    super(message);
    this.name = 'DeviceVerificationRequiredError';
  }
}

export class DeviceVerificationCancelledError extends Error {
  constructor() {
    super('Device verification was cancelled');
    this.name = 'DeviceVerificationCancelledError';
  }
}
