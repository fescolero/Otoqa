/**
 * Facility linking — ctx-level glue over the pure matchers in
 * facilityMatch.ts, shared by every stop-creation path.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
  resolveFacilityForStop,
  type LaneStopBinding,
  type MatchableStop,
} from './facilityMatch';

export async function getActiveFacilities(
  ctx: MutationCtx,
  customerId: Id<'customers'>,
): Promise<Doc<'facilities'>[]> {
  return await ctx.db
    .query('facilities')
    .withIndex('by_customer', (q) => q.eq('customerId', customerId).eq('isDeleted', false))
    .collect();
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().toUpperCase();
  return t.length > 0 ? t : undefined;
}

/**
 * Decide the facility link + coordinate snap for a stop being created.
 *
 * `binding` comes from the lane's stop plan (position-matched by the
 * caller): an explicit facilityId wins outright; a NASS code matches
 * against facilities.externalCode. Either must resolve to an active
 * facility. Without a binding hit, the pure resolver runs (proximity when
 * the stop has coordinates, address agreement otherwise).
 *
 * Snap rule: a VERIFIED facility's pin always overrides the stop's
 * coordinates (import pins are often centroid geocodes). An UNVERIFIED
 * pin is used only when the stop has no coordinates at all (recurring /
 * manual stops) — some pin beats no pin, and soft geofence mode keeps a
 * wrong one non-blocking.
 */
export function resolveStopFacilityLink(
  stop: MatchableStop,
  facilities: Doc<'facilities'>[],
  binding?: LaneStopBinding,
): { facilityId: Id<'facilities'>; latitude?: number; longitude?: number } | null {
  let facility: Doc<'facilities'> | null = null;
  if (binding?.facilityId) {
    facility = facilities.find((f) => f._id === binding.facilityId) ?? null;
  }
  if (!facility && binding?.nassCode) {
    const code = normalizeCode(binding.nassCode);
    facility = code
      ? (facilities.find((f) => normalizeCode(f.externalCode) === code) ?? null)
      : null;
  }
  if (!facility) {
    facility = resolveFacilityForStop(stop, facilities);
  }
  if (!facility) return null;

  const stopHasCoords =
    typeof stop.latitude === 'number' && typeof stop.longitude === 'number';
  const snap = facility.verificationState === 'VERIFIED' || !stopHasCoords;

  return {
    facilityId: facility._id,
    ...(snap ? { latitude: facility.latitude, longitude: facility.longitude } : {}),
  };
}
