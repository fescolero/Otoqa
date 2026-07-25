// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project root (monorepo root)
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..', '..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [monorepoRoot];

// 2. Let Metro know where to resolve packages from
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Ensure proper resolution for monorepo setup
// Note: disableHierarchicalLookup should be false (default) for EAS builds

// Force singleton resolution for packages that MUST have exactly one copy
// in the bundle. In the bun workspace, RN libraries hoist to the repo root
// while react/react-dom/react-native are pinned per-app (Expo SDK 54
// requires react 19.1.0 exactly; the web app uses a newer react at root).
// Without this, a root-hoisted library resolves the ROOT react and the
// bundle ships two reacts -> crash on open (invalid hook call / renderer
// mismatch).
const SINGLETONS = ['react', 'react-dom', 'react-native'];
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const hit = SINGLETONS.find((s) => moduleName === s || moduleName.startsWith(s + '/'));
  if (hit) {
    const redirected = path.join(projectRoot, 'node_modules', moduleName);
    return context.resolveRequest(context, redirected, platform);
  }
  if (baseResolveRequest) return baseResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

