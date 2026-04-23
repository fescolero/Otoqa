import { ConvexHttpClient } from 'convex/browser';
import { storage } from './storage';
import { log } from './log';
import { getFreshToken } from './auth-token-store';
import { api } from '../../convex/_generated/api';

// ============================================================================
// FEATURE FLAGS — client wrapper around the Convex featureFlags table
// ============================================================================
//
// Read path is offline-first: we check the cached AsyncStorage blob before
// attempting any network call, so first-open after a cold start boots on
// the flag values we saw last session. A background refresh then pulls the
// current values for next launch.
//
// Deleted as part of Phase 5 cleanup along with the Convex table and the
// location-storage.ts dispatcher.
// ============================================================================

const lg = log('FeatureFlags');
const CACHE_KEY = 'feature_flags_cache';

type FlagMap = Record<string, string>;
type Backend = 'mmkv' | 'sqlite';

let inMemory: FlagMap | null = null;

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
// We intentionally create a fresh HTTP client here instead of reusing the
// ConvexReactClient — feature-flag fetches can happen before React mounts,
// during root-init, when the ReactClient's auth isn't yet wired.
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

async function refreshFromServer(): Promise<void> {
  if (!httpClient) return;
  try {
    const token = await getFreshToken();
    if (!token) return; // not signed in yet — keep cached values
    httpClient.setAuth(token);
    const flags = await httpClient.query(api.featureFlags.getForOrg, {});
    inMemory = flags;
    await storage.set(CACHE_KEY, JSON.stringify(flags));
    lg.debug(`Refreshed ${Object.keys(flags).length} flag(s) from Convex`);
  } catch (err) {
    // Offline, unauthenticated, or Convex unreachable — keep cached values.
    lg.debug(`Flag refresh failed (using cached): ${err}`);
  }
}

/**
 * Resolve the GPS queue backend for this app session. Cached-first: returns
 * immediately from AsyncStorage without waiting on the network, then fires
 * a background refresh so the next launch reads the current value.
 *
 * Default is 'sqlite' — a device with no cache and no network boots on the
 * legacy backend. The MMKV canary org has to have gps_queue_backend=mmkv
 * explicitly set in Convex before drivers on that org will pick it up.
 */
export async function getQueueBackend(): Promise<Backend> {
  const flags = await loadCacheIntoMemory();

  // Kick off a background refresh — don't await; next launch benefits.
  refreshFromServer().catch(() => {});

  const cached = flags.gps_queue_backend;
  return cached === 'mmkv' || cached === 'sqlite' ? cached : 'sqlite';
}
