// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project root (monorepo root)
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..');

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

module.exports = config;

