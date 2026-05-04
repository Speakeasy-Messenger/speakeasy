import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { installErrorHandler } from './src/diag/install-error-handler';

// Capture uncaught JS errors + unhandled rejections to AsyncStorage so
// the next launch can surface them on the DiagnosticsScreen. Must run
// before any app code so it sees errors during initial render.
installErrorHandler();

AppRegistry.registerComponent(appName, () => App);
