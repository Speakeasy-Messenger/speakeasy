// react-native-reanimated must be imported once at the entry point
// before any component that calls useSharedValue / useAnimatedProps
// renders. Some builds initialize lazily and the first paid-avatar
// render (e.g. when the local user is wearing a rare or legendary
// from rc.17 onwards) can hit the worklet runtime before it's ready,
// producing a hard JS exception in the AnimalSvg subtree. Importing
// here forces init.
import 'react-native-reanimated';

// CRITICAL: Import Firebase messaging to register headless task
// The module registers AppRegistry.registerHeadlessTask() when imported,
// which is required for background FCM messages to wake the app.
// Without this import, the headless task is never registered and
// background messages are queued by Android until foreground.
import '@react-native-firebase/messaging';

import notifee from '@notifee/react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { installErrorHandler } from './src/diag/install-error-handler';

// Capture uncaught JS errors + unhandled rejections to AsyncStorage so
// the next launch can surface them on the DiagnosticsScreen. Must run
// before any app code so it sees errors during initial render.
installErrorHandler();

// Notifee foreground service backing the ongoing voice-call pill (Android).
// Must be registered once at startup, before any `asForegroundService`
// notification is displayed. The task promise intentionally never resolves —
// the service lives until the pill notification is cancelled at call end
// (dismissOngoingCallNotification). Keeping the backgrounded audio-call
// process alive is the whole point: without it One UI kills the call within
// seconds of backgrounding, which is why the plain pill never appeared.
notifee.registerForegroundService(() => new Promise(() => {}));

AppRegistry.registerComponent(appName, () => App);

// Headless JS task fired by the native messaging notification's
// inline-reply BroadcastReceiver (see
// `xyz.speakeasyapp.app.notif.NotifMessagingReplyService`). Forwards
// to the same JS reply handler the notifee fallback uses so the
// encrypt + WS send pipeline isn't duplicated in Kotlin.
AppRegistry.registerHeadlessTask('SpeakeasyInlineReply', () => async (data) => {
  const { handleInlineReplyFromData } = await import(
    './src/push/push-handler.js'
  );
  await handleInlineReplyFromData({
    conversationId: data?.conversationId,
    senderId: data?.senderId,
    msgType: data?.msgType,
    replyText: data?.replyText,
  });
});
