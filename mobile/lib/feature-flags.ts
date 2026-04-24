import { ConvexHttpClient } from 'convex/browser';
import { storage } from './storage';
import { log } from './log';
import { getFreshToken } from './auth-token-store';
import { api } from '../../convex/_generated/api';

// ============================================================================
// FEATURE FLAGS — client wrapper around the Convex featureFlags table
// ============================================================================
//
// Read path is offline-first but with a bounded wait on the very first call
// per app-launch (empty cache): we give a fresh server fetch ~1.5 seconds
// to land before falling back to the in-code default. Later launches always
// hit the cache instantly and refresh in the background.
//
// Clerk-race defense: the refresh needs a Clerk token, and Clerk's auth
// singleton isn't always loaded at root-init. refreshFromServer() retries
// with backoff when getFreshToken() returns null, and is also re-triggered
// explicitly on app foreground-resume (by the root layout) — at which
// point Clerk is guaranteed to be loaded.
//
// Deleted as part of Phase 5 cleanup along with the Convex table and the
// location-storage.ts dispatcher.
// ============================================================================

const lg = log('FeatureFlags');
const CACHE_KEY = 'feature_flags_cache';

// Canonical flag keys. Every value in the Convex `featureFlags` table is
// serialized as a string (the column type is v.string()) — the accessors
// below parse each one to the right shape. Add a new flag by:
//   1) inserting a row in `featureFlags` (see convex/featureFlags.ts)
//   2) adding the key constant here
//   3) calling getFlagBool / getFlagNumber / getFlagString at the read site
export const FLAG_GPS_QUEUE_BACKEND = 'gps_queue_backend';
export const FLAG_QUEUE_ENCRYPTION_ENABLED = 'queue_encryption_enabled';
export const FLAG_PING_INGESTED_SAMPLE_RATE = 'ping_ingested_sample_rate';
// Phase 1 — Activity Recognition + FCM wake-up capability gates.
//   ar_wake_enabled   : motion-service subscribes to AR transitions +
//                       starts FGS on STILL→IN_VEHICLE
//   ar_shadow_mode    : AR fires telemetry only; FGS start is suppressed
//                       (required ≥7-day observation step before the
//                        ar_wake_enabled flip — see architecture doc)
//   fcm_wake_enabled  : both server sweep (dispatch) and mobile handler
//                       (receive) gate on this flag
export const FLAG_AR_WAKE_ENABLED = 'ar_wake_enabled';
export const FLAG_AR_SHADOW_MODE = 'ar_shadow_mode';
export const FLAG_FCM_WAKE_ENABLED = 'fcm_wake_enabled';

// How long getQueueBackend is willing to wait on a fresh refresh when the
// cache is empty, before falling back to the in-code default (sqlite).
// Keeps first-launch cold-start delay bounded while still giving an online
// device a real chance to get the right backend without needing two cold
// starts.
const FIRST_LAUNCH_REFRESH_TIMEOUT_MS = 1500;

// Retry backoff for the Clerk-not-loaded case. Root-init fires well before
// Clerk's singleton is populated; we retry at these offsets until either a
// token becomes available or we give up. Offsets sum to ~10 seconds across
// the first cold start.
const REFRESH_RETRY_DELAYS_MS = [500, 1500, 3000, 5000];

type FlagMap = Record<string, string>;
type Backend = 'mmkv' | 'sqlite';

let inMemory: FlagMap | null = null;

// One in-flight refresh at a time. getQueueBackend needs to observe its
// completion to unblock the first-launch wait, and multiple triggers (boot
// + foreground resume + retry) shouldn't stampede Convex.
let inflightRefresh: Promise<void> | null = null;

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
// Fresh HTTP client, not the ConvexReactClient — feature-flag fetches can
// happen before React mounts, during root-init, when the ReactClient's auth
// isn't yet wired.
const httpClient: ConvexHttpClient | null = CONVEX_URL
  ? new ConvexHttpClient(CONVEX_URL)
  : null;

async function loadCacheIntoMemory(): Promise<FlagMap> {
  if (inMemory) return inMemory;
  try {
    const raw = await storage.getString(CACHE_KEY);
    if (raw) {
      inMemory = JSON.parse(raw) as FlagMap;
    } else {
      inMemory = {};
    }
  } catch (err) {
    lg.warn(`Failed to read flag cache: ${err}`);
    inMemory = {};
  }
  return inMemory;
}

/**
 * Single refresh attempt: fetch from Convex, update in-memory + AsyncStorage
 * cache. Returns true on successful fetch (cache is fresh), false on any
 * failure (no token / offline / Convex error) — the caller decides whether
 * to retry.
 */
async function attemptRefresh(): Promise<boolean> {
  if (!httpClient) return false;
  try {
    const token = await getFreshToken();
    if (!token) return false; // Clerk not loaded yet — caller will retry.
    httpClient.setAuth(token);
    const flags = await httpClient.query(api.featureFlags.getForOrg, {});
    inMemory = flags;
    await storage.set(CACHE_KEY, JSON.stringify(flags));
    lg.debug(`Refreshed ${Object.keys(flags).length} flag(s) from Convex`);
    return true;
  } catch (err) {
    lg.debug(
      `Flag refresh attempt failed (using cached): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Retry-aware refresh. Single in-flight call across the whole app; if a
 * refresh is already running, returns the same promise so callers chain on
 * the existing cycle rather than starting another. On each attempt that
 * comes back "no token yet," we wait a backoff and try again — works around
 * the Clerk-singleton race at root-init.
 */
function refreshFromServer(): Promise<void> {
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    for (let i = 0; i <= REFRESH_RETRY_DELAYS_MS.length; i++) {
      const ok = await attemptRefresh();
      if (ok) return;
      if (i === REFRESH_RETRY_DELAYS_MS.length) return; // out of retries
      await new Promise((resolve) =>
        setTimeout(resolve, REFRESH_RETRY_DELAYS_MS[i]),
      );
    }
  })().finally(() => {
    inflightRefresh = null;
  });

  return inflightRefresh;
}

/**
 * Public: trigger a refresh cycle. Intended for use on events where Clerk
 * is known to be loaded (e.g., foreground resume, auth_setup_complete).
 * Idempotent — joins any in-flight refresh rather than stacking.
 */
export function refreshFlagsFromServer(): Promise<void> {
  return refreshFromServer();
}

/**
 * Phase 1c — reactive subscription entry point.
 *
 * Write a fresh flag snapshot into the in-memory + AsyncStorage cache.
 * Called from the root layout's `useQuery(api.featureFlags.getForOrg)`
 * effect whenever Convex pushes a new value. This is the kill-switch
 * path: flipping `ar_wake_enabled=false` or `fcm_wake_enabled=false`
 * takes effect within seconds on every active tracking client,
 * without requiring a cold start.
 *
 * Accepts a snapshot directly (not a mutation to `inMemory`) so the
 * React effect can pass whatever Convex returned without deep-diffing
 * first — the write here is small (a stringify + MMKV set).
 */
export function applyFlagSnapshot(flags: FlagMap): void {
  inMemory = flags;
  storage.set(CACHE_KEY, JSON.stringify(flags)).catch((err) => {
    lg.warn(
      `Failed to persist reactive flag snapshot: ${err instanceof Error ? err.message : err}`,
    );
  });
}

/**
 * Resolve the GPS queue backend for this app session.
 *
 * First call per launch with an empty cache: give the server refresh up to
 * FIRST_LAUNCH_REFRESH_TIMEOUT_MS to land before falling back to the
 * in-code default. This is the critical path that determines whether a
 * fresh install on a canary org boots on MMKV or on legacy SQLite — we
 * want online devices to get the right backend on the very first launch,
 * not need a second cold start.
 *
 * Later calls per launch hit the populated cache immediately and fire the
 * refresh in the background for the next launch.
 *
 * Default is 'sqlite' — a device with no cache, no network, and no token
 * boots on the legacy backend. That's the right behavior: first-launch
 * offline on a canary org stays on the legacy backend until the device
 * gets a chance to read the flag.
 */
export async function getQueueBackend(): Promise<Backend> {
  const flags = await loadCacheIntoMemory();
  const cached = flags.gps_queue_backend;

  if (cached === 'mmkv' || cached === 'sqlite') {
    // Warm cache — use it, refresh for next launch.
    refreshFromServer().catch(() => {});
    return cached;
  }

  // Cold cache. Give the refresh a bounded chance to land before we
  // fall back to the default.
  try {
    await Promise.race([
      refreshFromServer(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, FIRST_LAUNCH_REFRESH_TIMEOUT_MS),
      ),
    ]);
  } catch {
    /* ignore — fall through to whatever inMemory holds now */
  }

  const refreshed = inMemory?.gps_queue_backend;
  return refreshed === 'mmkv' || refreshed === 'sqlite' ? refreshed : 'sqlite';
}

// ============================================================================
// GENERIC TYPED ACCESSORS
// ============================================================================
//
// Cache-first, non-blocking. Returns whatever is in the local cache and fires
// a background refresh for the next launch. On a truly cold cache (first app
// launch, no network), returns the caller-supplied default.
//
// For flags that gate capabilities which can be safely disabled on first
// launch (Phase 0/1: queue_encryption_enabled, ping_ingested_sample_rate,
// ar_wake_enabled, fcm_wake_enabled), this is the right shape — defaults are
// conservative (off / low-impact) so a cold-cache launch can't ship anything
// dangerous.
//
// Flags that *require* the right value on first launch (today: only
// gps_queue_backend — picking the wrong backend would strand data) should
// use getQueueBackend above instead, which does a bounded-wait refresh.
// ============================================================================

async function getRawFlag(key: string): Promise<string | undefined> {
  const flags = await loadCacheIntoMemory();
  // Kick off a refresh for the next launch. Don't await — the caller gets
  // whatever the cache has now.
  refreshFromServer().catch(() => {});
  return flags[key];
}

export async function getFlagString(
  key: string,
  defaultValue: string,
): Promise<string> {
  const raw = await getRawFlag(key);
  return raw ?? defaultValue;
}

export async function getFlagBool(
  key: string,
  defaultValue: boolean,
): Promise<boolean> {
  const raw = await getRawFlag(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Any other stored value (empty string, garbage, undefined) → default.
  // A malformed flag value shouldn't silently flip a capability on.
  return defaultValue;
}

export async function getFlagNumber(
  key: string,
  defaultValue: number,
): Promise<number> {
  const raw = await getRawFlag(key);
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}
