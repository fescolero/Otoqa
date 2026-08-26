/**
 * yard-fences.ts — the org's yard/parking fences, cached on the device.
 *
 * The driver app has never known where its org's yards are: yard geofencing
 * is evaluated server-side from the synced ping stream
 * (convex/yardGeofence.ts). The end-shift reminder needs the same decision
 * made locally and immediately — when a driver rolls back into the yard they
 * started in, the nudge has to fire on the phone, offline, without waiting
 * for a batch to sync and a push to come back.
 *
 * So the fences come down once per shift and live in `storage` until the
 * next refresh. They are small (a name and a circle), they change rarely,
 * and a stale copy degrades gracefully: a yard added today just doesn't
 * arm a reminder until the driver's next shift start.
 *
 * Both radii are resolved server-side (`yardLocations.listForDriver`). The
 * device never re-derives them — `exitRadiusFor(undefined)` returns the
 * load-stop departure ring, not 1.5x the yard default, and that trap is not
 * worth re-litigating in a second codebase.
 *
 * The geometry lives next door in yard-fence-math.ts, which imports nothing
 * from React Native or Convex so it can be unit-tested in node; this module
 * is the I/O half and re-exports it for callers.
 *
 * See docs/end-shift-reminder-spec.md.
 */

import { ConvexHttpClient } from 'convex/browser';
import { storage } from './storage';
import { log } from './log';
import { getFreshToken } from './auth-token-store';
import type { YardFence } from './yard-fence-math';
import { api } from '../../../convex/_generated/api';

export type { YardFence, FenceZone } from './yard-fence-math';
export { distanceMeters, zoneFor, findEnclosingFence } from './yard-fence-math';

const lg = log('YardFences');

const CACHE_KEY = 'yard_fences_cache';

type FenceCache = {
  // Org-stamped: a driver who re-signs into a different org must not
  // evaluate against the previous org's yards. Cheaper and more obvious
  // than clearing the cache from every path that can change orgs.
  organizationId: string;
  fetchedAt: number;
  fences: YardFence[];
};

let inMemory: FenceCache | null = null;

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
// Fresh HTTP client rather than the ConvexReactClient: refreshes can run
// from the shift-start path before React's auth is wired, and later from
// the headless background task, which has no React context at all. Same
// reasoning as feature-flags.ts.
const httpClient: ConvexHttpClient | null = CONVEX_URL
  ? new ConvexHttpClient(CONVEX_URL)
  : null;

// ============================================================================
// CACHE
// ============================================================================

async function loadCache(): Promise<FenceCache | null> {
  if (inMemory) return inMemory;
  try {
    const raw = await storage.getString(CACHE_KEY);
    if (!raw) return null;
    inMemory = JSON.parse(raw) as FenceCache;
    return inMemory;
  } catch (err) {
    lg.warn(`Failed to read fence cache: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * The cached fences for this org, or an empty list. Never fetches: callers
 * on the GPS path must not block on the network, and an empty list is a
 * correct answer — it means "no reminder is armed", which is exactly the
 * behavior for an org with no yards configured.
 */
export async function getCachedYardFences(organizationId: string): Promise<YardFence[]> {
  const cache = await loadCache();
  if (!cache) return [];
  if (cache.organizationId !== organizationId) return [];
  return cache.fences;
}

/**
 * Pull a fresh copy from Convex. Returns the fences on success, null on any
 * failure (no token, offline, server error) — the previous cache is left
 * untouched in that case, since a stale fence is worth far more than none.
 *
 * Fire-and-forget by design: no caller should await this on a path the
 * driver is watching.
 */
export async function refreshYardFences(
  organizationId: string,
): Promise<YardFence[] | null> {
  if (!httpClient) return null;
  try {
    const token = await getFreshToken();
    if (!token) {
      lg.debug('Fence refresh skipped — no auth token yet');
      return null;
    }
    httpClient.setAuth(token);
    const rows = await httpClient.query(api.yardLocations.listForDriver, {});
    const fences: YardFence[] = rows.map((row) => ({
      id: row._id,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      entryRadiusMeters: row.radiusMeters,
      exitRadiusMeters: row.exitRadiusMeters,
    }));
    const cache: FenceCache = { organizationId, fetchedAt: Date.now(), fences };
    inMemory = cache;
    await storage.set(CACHE_KEY, JSON.stringify(cache));
    lg.debug(`Cached ${fences.length} yard fence(s)`);
    return fences;
  } catch (err) {
    lg.debug(
      `Fence refresh failed (keeping cache): ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/** Drop the cache. Called on sign-out — the next driver may be another org. */
export async function clearYardFences(): Promise<void> {
  inMemory = null;
  try {
    await storage.delete(CACHE_KEY);
  } catch {
    // Non-critical: the org stamp on the cache already prevents cross-org
    // evaluation, so a failed delete is untidy rather than incorrect.
  }
}
