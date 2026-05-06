const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const defaultConfig = getDefaultConfig(projectRoot);

/**
 * Custom resolver to handle TypeScript ESM imports that use `.js`
 * extensions (e.g. `import './foo.js'` where the actual source is
 * `./foo.ts`). Idiomatic for Node ESM + TS projects but Metro's
 * default resolver looks at the literal extension and gives up.
 *
 * This wraps Metro's built-in resolver: try the import as written
 * first, and if it fails with a no-such-file error, retry with the
 * `.js` stripped so Metro's normal extension-list (`.ts`, `.tsx`,
 * `.native.ts`, `.ios.ts`, etc.) gets a shot.
 */
const previousResolveRequest = defaultConfig.resolver.resolveRequest;

// react-native-webrtc 124 declares `event-target-shim@6.0.2` as a
// dependency, and v6 exports an `Event` class that rn-webrtc's compiled
// code references (`new _index.Event('...')`, `class … extends
// _index.Event`). npm hoists `event-target-shim@5.0.1` to the workspace
// root because RN itself depends on the 5.x line, leaving the v6 copy
// nested under `node_modules/react-native-webrtc/node_modules/`.
//
// With `disableHierarchicalLookup: true` (set below for the monorepo),
// Metro doesn't crawl up from the importing file's directory and so
// never finds the nested v6 — every `require('event-target-shim/index')`
// from rn-webrtc resolves to v5, which has no `Event` export.
//
// Symptom: release builds (debug dev server tolerates it) crash on the
// first `new RTCPeerConnection()` with a JS `TypeError` from `_inherits`
// — Babel's `class … extends undefined` helper. Trace:
//
//   _inherits → anonymous (rn-webrtc submodule body)
//             → metroRequire (lazy load)
//             → WebRtcCallPeer constructor
//             → orchestrator.startOutgoing
//
// Fix: pin every rn-webrtc-side `event-target-shim/index` import to the
// nested v6 file path. Other consumers of `event-target-shim` (RN's own
// 5.x use) keep resolving via the hoisted root.
const RN_WEBRTC_SHIM_INDEX = path.resolve(
  monorepoRoot,
  'node_modules/react-native-webrtc/node_modules/event-target-shim/index.js',
);

function resolveTsJsImports(context, moduleName, platform) {
  const inner = previousResolveRequest ?? context.resolveRequest;
  if (
    (moduleName === 'event-target-shim/index' ||
      moduleName === 'event-target-shim/index.js' ||
      moduleName === 'event-target-shim') &&
    typeof context.originModulePath === 'string' &&
    context.originModulePath.includes('/react-native-webrtc/')
  ) {
    return { type: 'sourceFile', filePath: RN_WEBRTC_SHIM_INDEX };
  }
  try {
    return inner(context, moduleName, platform);
  } catch (err) {
    if (moduleName.endsWith('.js')) {
      const stripped = moduleName.slice(0, -'.js'.length);
      return inner(context, stripped, platform);
    }
    throw err;
  }
}

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    disableHierarchicalLookup: true,
    resolveRequest: resolveTsJsImports,
  },
};

module.exports = mergeConfig(defaultConfig, config);
