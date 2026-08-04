/**
 * Re-export shim — the theme's source of truth is @otoqa/mobile-core
 * (packages/mobile-core/theme.ts). This file exists so the driver app's
 * existing `lib/theme` imports keep working; new code should import from
 * the package directly.
 */
export * from '@otoqa/mobile-core/theme';
