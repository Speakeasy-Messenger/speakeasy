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
function resolveTsJsImports(context, moduleName, platform) {
  const inner = previousResolveRequest ?? context.resolveRequest;
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
