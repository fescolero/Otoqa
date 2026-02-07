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
    ignores: ['**/*-old.*'],
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
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react/no-unescaped-entities': 'warn',
    },
  },
  ...convexOverrides,
  {
    files: ['mobile/**/*.{ts,tsx,js,jsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
]);
