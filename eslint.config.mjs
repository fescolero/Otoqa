import { defineConfig } from 'eslint/config';
import convexPlugin from '@convex-dev/eslint-plugin';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const convexRecommended = convexPlugin.configs.recommended ?? {};
const convexOverrides = (convexRecommended.overrides ?? []).map((override) => ({
  ...override,
  plugins: { '@convex-dev': convexPlugin },
}));

export default defineConfig([
  {
    // apps/*/.next: Next's root ignore only covers the repo-root build dir,
    // so workspace-app build output (e.g. apps/admin/.next from a local
    // `next build`) must be excluded explicitly.
    ignores: ['**/*-old.*', 'apps/*/.next/**'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    plugins: { '@convex-dev': convexPlugin },
    rules: convexRecommended.rules ?? {},
  },
  {
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'prefer-const': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react/no-unescaped-entities': 'warn',
    },
  },

  // ---------------------------------------------------------------------
  // Convex queries must go through the auth-gated hooks.
  //
  // A raw `useQuery` / `usePaginatedQuery` runs as soon as the component
  // mounts, which can be before the Convex client has finished its auth
  // handshake and attached a token. The server then throws
  // `Unauthenticated` — the single largest source of production error-
  // tracking noise in this app, and the cause of the `loads:getLoads`
  // incident. `useAuthQuery` / `useAuthPaginatedQuery` hold the query at
  // `'skip'` until `useConvexAuth().isAuthenticated` is true.
  //
  // Scope note: web app only. apps/driver and apps/dispatch drive Convex
  // auth through their own ConvexAuthProvider and have no equivalent hook,
  // so the rule would be wrong there. convex/ is server code.
  // ---------------------------------------------------------------------
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'convex/react',
              importNames: ['useQuery', 'usePaginatedQuery'],
              message:
                "Use useAuthQuery / useAuthPaginatedQuery from '@/hooks/use-auth-query' instead. A raw Convex query can fire before the auth handshake completes and throw Unauthenticated server-side. If this query genuinely does not require auth, disable this rule on the line with a comment saying why.",
            },
          ],
        },
      ],
    },
  },
  {
    // The gated hooks are the one place allowed to import the raw ones.
    files: ['hooks/use-auth-query.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  ...convexOverrides,
  {
    files: ['apps/driver/**/*.{ts,tsx,js,jsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
]);
