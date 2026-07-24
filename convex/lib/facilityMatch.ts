/**
 * Facility matching — pure functions shared by every stop-creation path
 * (FourKites import, recurring-load generation, manual load creation) and
 * by promoteUnmappedLoad's re-match.
 *
 * Matching strategy (see docs/fourkites-address-quality-plan.md §2.6):
 *   1. Lane binding: a contract lane's stop plan carries facilityId per
 *      position — position match guarded by count + per-position city
 *      agreement (handled by the caller, which knows the lane).
 *   2. Proximity fallback: nearest facility pin to the stop's coordinates
 *      wins when it's inside MATCH_MAX_DISTANCE_METERS AND beats the
 *      runner-up by MATCH_MARGIN_RATIO. A city disagreement past
 *      CITY_VETO_DISTANCE_METERS vetoes. No unique winner → no match —
 *      unmatched is soft mode, never a failure.
 */
import { calculateDistanceMeters } from './geo';

// A stop matches only within this distance of a facility pin. Generous on
// purpose: the whole point is that import pins can be city-centroid
// geocodes kilometers off in rural geography.
export const MATCH_MAX_DISTANCE_METERS = 15_000;

// The winner must be this many times closer than the runner-up, otherwise
// the match is ambiguous (two facilities in the same town) and we abstain.
export const MATCH_MARGIN_RATIO = 3;

// Beyond this distance, a city-name disagreement vetoes the match even if
// the facility is nearest — catches a brand-new location near an existing
// facility without reintroducing string-matching fragility.
export const CITY_VETO_DISTANCE_METERS = 8_000;

export interface MatchableFacility {
  _id: string;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude: number;
  longitude: number;
}

export interface MatchableStop {
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().toLowerCase();
  return t.length > 0 ? t : undefined;
}

export interface FacilityMatch<F extends MatchableFacility> {
  facility: F;
  distanceMeters: number;
}

/**
 * Proximity match a single stop against a customer's facilities.
 * Returns null when there is no unique, plausible winner.
 */
export function matchStopToFacility<F extends MatchableFacility>(
  stop: MatchableStop,
  facilities: F[],
): FacilityMatch<F> | null {
  if (
    typeof stop.latitude !== 'number' ||
    typeof stop.longitude !== 'number' ||
    !Number.isFinite(stop.latitude) ||
    !Number.isFinite(stop.longitude) ||
    facilities.length === 0
  ) {
    return null;
  }

  let best: FacilityMatch<F> | null = null;
  let runnerUpDistance = Infinity;
  for (const facility of facilities) {
    const distance = calculateDistanceMeters(
      stop.latitude,
      stop.longitude,
      facility.latitude,
      facility.longitude,
    );
    if (!best || distance < best.distanceMeters) {
      runnerUpDistance = best ? best.distanceMeters : Infinity;
      best = { facility, distanceMeters: distance };
    } else if (distance < runnerUpDistance) {
      runnerUpDistance = distance;
    }
  }

  if (!best || best.distanceMeters > MATCH_MAX_DISTANCE_METERS) {
    return null;
  }

  // Margin rule: ambiguous winners abstain. Infinity runner-up (single
  // facility) always passes.
  if (runnerUpDistance < best.distanceMeters * MATCH_MARGIN_RATIO) {
    return null;
  }

  // City veto: far match + disagreeing city names = probably a different
  // location. Missing city on either side never vetoes.
  const stopCity = normalize(stop.city);
  const facilityCity = normalize(best.facility.city);
  if (
    best.distanceMeters > CITY_VETO_DISTANCE_METERS &&
    stopCity &&
    facilityCity &&
    stopCity !== facilityCity
  ) {
    return null;
  }

  return best;
}

/**
 * Address-based match for stops WITHOUT coordinates (recurring-load
 * templates and manual stops don't carry lat/lng). Both sides here are
 * user-entered — facilities from the Locations tab, template/manual stops
 * from forms — so exact text agreement is trustworthy in a way FourKites
 * city strings are not. Match requires: same normalized city AND state;
 * when both sides have a postal code it must agree too; and exactly ONE
 * candidate facility — two facilities in the same town abstain.
 */
export function matchStopToFacilityByAddress<F extends MatchableFacility>(
  stop: MatchableStop,
  facilities: F[],
): F | null {
  const stopCity = normalize(stop.city);
  const stopState = normalize(stop.state);
  if (!stopCity || !stopState) return null;
  const stopZip = normalize(stop.postalCode);

  const candidates = facilities.filter((f) => {
    if (normalize(f.city) !== stopCity || normalize(f.state) !== stopState) return false;
    const facilityZip = normalize(f.postalCode);
    if (stopZip && facilityZip && stopZip !== facilityZip) return false;
    return true;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Combined per-stop resolution: proximity when the stop has coordinates,
 * address agreement otherwise. Used by every creation path that has no
 * lane binding for the stop.
 */
export function resolveFacilityForStop<F extends MatchableFacility>(
  stop: MatchableStop,
  facilities: F[],
): F | null {
  if (typeof stop.latitude === 'number' && typeof stop.longitude === 'number') {
    return matchStopToFacility(stop, facilities)?.facility ?? null;
  }
  return matchStopToFacilityByAddress(stop, facilities);
}

export interface LaneStopBinding {
  facilityId?: string;
  nassCode?: string;
}

/**
 * Align a contract lane's facility bindings (explicit facilityId and/or
 * NASS code) to a shipment's stops by position. Same all-or-nothing
 * contract as laneAddressesByPosition in fourKitesUtils: count mismatch or
 * any per-position city disagreement (when both sides have one) yields no
 * bindings — a positional off-by-one would geofence every subsequent stop
 * against the wrong building.
 *
 * Lane stops are ordered by stopOrder, shipment stops by their sequence
 * field; the result is returned in the SHIPMENT ARRAY'S original order.
 */
export function laneBindingsByPosition(
  laneStops: unknown,
  shipmentStops: Array<{ sequence?: number; city?: string }>,
): Array<LaneStopBinding | undefined> {
  const none = shipmentStops.map(() => undefined);
  if (!Array.isArray(laneStops) || laneStops.length !== shipmentStops.length) {
    return none;
  }

  const orderedLane = [...laneStops].sort(
    (a, b) => (a?.stopOrder ?? 0) - (b?.stopOrder ?? 0),
  );
  const orderedShipment = [...shipmentStops].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  );

  for (let i = 0; i < orderedShipment.length; i++) {
    const laneCity = normalize(orderedLane[i]?.city);
    const shipCity = normalize(orderedShipment[i]?.city);
    if (laneCity && shipCity && laneCity !== shipCity) {
      return none;
    }
  }

  const bySortedIndex = new Map<object, LaneStopBinding | undefined>();
  orderedShipment.forEach((stop, i) => {
    const facilityId = orderedLane[i]?.facilityId;
    const nassCode = orderedLane[i]?.nassCode;
    const binding: LaneStopBinding = {
      ...(typeof facilityId === 'string' ? { facilityId } : {}),
      ...(typeof nassCode === 'string' && nassCode.trim() ? { nassCode: nassCode.trim() } : {}),
    };
    bySortedIndex.set(stop, Object.keys(binding).length > 0 ? binding : undefined);
  });
  return shipmentStops.map((stop) => bySortedIndex.get(stop));
}
