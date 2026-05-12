// react-native-reanimated must be imported once at the entry point
// before any component that calls useSharedValue / useAnimatedProps
// renders. Some builds initialize lazily and the first paid-avatar
// render (e.g. when the local user is wearing a rare or legendary
// from rc.17 onwards) can hit the worklet runtime before it's ready,
// producing a hard JS exception in the AnimalSvg subtree. Importing
// here forces init.
import 'react-native-reanimated';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { installErrorHandler } from './src/diag/install-error-handler';

// Capture uncaught JS errors + unhandled rejections to AsyncStorage so
// the next launch can surface them on the DiagnosticsScreen. Must run
// before any app code so it sees errors during initial render.
installErrorHandler();

AppRegistry.registerComponent(appName, () => App);
