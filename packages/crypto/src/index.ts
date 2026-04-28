export type {
  SignalProtocolModule,
  SignalSessionState,
  IdentityKey,
  OwnPreKeyBundle,
  PeerPreKeyBundle,
  SignalClientErrorReason,
} from './signal-protocol.js';
export { NativeSignalProtocolModule, SignalClientError } from './signal-protocol.js';

export type { ChannelKeyModule } from './channel-key.js';
export { NativeChannelKeyModule } from './channel-key.js';

// `SoftwareChannelKeyModule` intentionally NOT re-exported: it depends on
// Node's built-in `node:crypto`, which doesn't exist in React Native's
// runtime and crashes Metro bundling. Server-side tests that need it
// import directly from './software-channel-key.js'.

export type {
  GroupMessagingModule,
  GroupMessagingClientErrorReason,
} from './group-messaging.js';
export {
  NativeGroupMessagingModule,
  GroupMessagingClientError,
} from './group-messaging.js';
export { MockGroupMessagingClient } from './mock-group-messaging.js';
