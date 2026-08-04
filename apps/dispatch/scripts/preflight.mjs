/**
 * Publish-time guard. Metro treats a `require()` inside try/catch as an
 * OPTIONAL dependency: if the package is missing from node_modules,
 * `eas update` does NOT fail — it silently ships a bundle without the
 * module (lost TTS, lost analytics), and the app degrades with no error
 * anywhere. This script makes that failure loud instead.
 *
 * Run automatically via `bun run update:preview`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REQUIRED = [
  'expo-speech',
  'expo-speech-recognition',
  'posthog-react-native',
  'expo-notifications',
  'expo-updates',
];

const missing = REQUIRED.filter((m) => {
  try {
    require.resolve(m);
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  console.error(
    `\n✖ Missing from node_modules: ${missing.join(', ')}\n` +
      '  Run `bun install` at the repo root, then retry.\n' +
      '  (Metro treats lazy requires as optional — publishing now would\n' +
      '  silently ship a bundle without these modules.)\n',
  );
  process.exit(1);
}
console.log('✓ preflight: all lazy-required modules resolve');
