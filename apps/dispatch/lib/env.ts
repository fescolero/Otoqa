/**
 * Client config with baked-in fallbacks.
 *
 * EXPO_PUBLIC_* vars are inlined at export time from dotenv files — and a
 * publish from a machine where that inlining fails used to ship a bundle
 * with no Convex URL, which threw at import time, crashed on boot, and made
 * expo-updates silently roll back (adb: "EXPO_PUBLIC_CONVEX_URL is not
 * set", process expo-updates-error-recovery). These values are PUBLIC
 * client identifiers, so hardcoding a fallback is safe and makes that
 * whole failure class impossible: env still wins when present.
 *
 * When migrating to a production Convex deployment / Clerk prod instance,
 * update the fallbacks here alongside .env.
 */
export const CONVEX_URL =
  process.env.EXPO_PUBLIC_CONVEX_URL ?? 'https://greedy-vole-262.convex.cloud';

export const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  'pk_test_Z2xvd2luZy1zaGVlcGRvZy05Ny5jbGVyay5hY2NvdW50cy5kZXYk';

export const WORKOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? 'client_01KAETKWFMGC6VEVXXB51A40QC';
