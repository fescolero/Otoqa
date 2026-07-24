/**
 * Server-side feature-flag reads.
 *
 * Lives in lib/ (not featureFlags.ts) so modules featureFlags.ts itself
 * imports from — e.g. driverMobile.ts, which it needs for
 * resolveAuthenticatedDriver — can read flags without a circular import.
 */
import type { QueryCtx, MutationCtx } from '../_generated/server';

/**
 * Read a single flag value for an explicit org from inside another Convex
 * function (query or mutation) — e.g. checkInAtStop consulting
 * `checkin_geofence_mode`. Returns undefined when the flag is unset so the
 * caller applies its in-code default.
 */
export async function getOrgFlagValue(
  ctx: QueryCtx | MutationCtx,
  workosOrgId: string,
  key: string,
): Promise<string | undefined> {
  const row = await ctx.db
    .query('featureFlags')
    .withIndex('by_org_key', (q) => q.eq('workosOrgId', workosOrgId).eq('key', key))
    .first();
  return row?.value;
}
