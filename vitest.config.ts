import { defineConfig } from 'vitest/config';

// convex-test requires the edge-runtime VM environment.
// See https://docs.convex.dev/functions/testing
export default defineConfig({
  test: {
    globals: true,
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['convex/**/*.test.ts'],
  },
});
