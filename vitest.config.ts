import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Two test projects:
 *   - convex: edge-runtime (existing, untouched behavior)
 *   - web: jsdom + React Testing Library for components/web/* primitives
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
    ],
  },
});
