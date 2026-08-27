import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Pin the timezone so a run means the same thing everywhere — a
 * developer in Los Angeles, one in Tokyo, and CI all agree. Assigned
 * at module scope so it is in `process.env` before Vitest forks its
 * workers, which inherit it; setting it inside a setup file is too
 * late for some environments.
 *
 * This buys reproducibility, NOT permission to assume UTC. Pinning
 * hides zone-dependent bugs as easily as it prevents flakes: the
 * `formatTimestamp` test passed on UTC CI for the life of the repo
 * while failing for anyone west of Greenwich, precisely because
 * nothing ever ran it in another zone. Tests that touch calendar
 * dates should still be written to hold in ANY zone — build inputs
 * in local time, or assert against the same formatter — so that a
 * genuine bug is not masked by the pin.
 */
process.env.TZ = 'UTC';

/**
 * Four test projects:
 *   - convex: edge-runtime (existing, untouched behavior)
 *   - web: jsdom + React Testing Library for components/web/* primitives
 *   - dispatch: node, pure logic under apps/dispatch/lib (voice parser)
 *   - driver: node, pure logic under apps/driver/lib (yard fence math)
 *
 * Run all: `npm run test`. Run one: `npx vitest --project=web`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'convex',
          globals: true,
          environment: 'edge-runtime',
          server: { deps: { inline: ['convex-test'] } },
          include: ['convex/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { '@': path.resolve(__dirname, '.') },
        },
        test: {
          name: 'web',
          globals: true,
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          include: ['components/web/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
          css: false,
        },
      },
      {
        resolve: {
          alias: {
            // The package barrel re-exports the legacy react-native theme, whose
            // Flow syntax the node environment can't parse. Dispatch's theme
            // imports the pure token file; mirror that resolution here.
            '@otoqa/mobile-core/design-tokens': path.resolve(
              __dirname,
              'packages/mobile-core/design-tokens.ts',
            ),
          },
        },
        test: {
          name: 'dispatch',
          globals: true,
          environment: 'node',
          include: ['apps/dispatch/lib/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'driver',
          globals: true,
          environment: 'node',
          // Only modules with no React Native / Expo imports are reachable
          // here — the driver app's testable logic is deliberately split out
          // from the I/O around it (see lib/yard-fence-math.ts).
          include: ['apps/driver/lib/**/*.test.ts'],
        },
      },
    ],
  },
});
