import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { useEffect, useState, useCallback, useRef } from 'react';
import { storage } from '../storage';
import { useNetworkStatus } from './useNetworkStatus';

// ============================================
// HOOK: GET DRIVER'S ASSIGNED LOADS
// With offline caching support
// ============================================

const LOADS_CACHE_KEY = 'cached_loads';
const LAST_SYNC_KEY = 'last_sync_time';

export function useMyLoads(driverId: Id<'drivers'> | null) {
  const { isOffline, isConnected } = useNetworkStatus();
  const [cachedLoads, setCachedLoads] = useState<any[] | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [isRefetching, setIsRefetching] = useState(false);

  // Round to nearest minute so the query arg doesn't change every millisecond,
  // which would cause constant re-subscriptions. Updates once per minute.
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  // Fetch from Convex (only when online and we have a driverId)
  const shouldSkip = !driverId || isOffline === true;
  const loads = useQuery(
    api.driverMobile.getMyAssignedLoads,
    shouldSkip ? 'skip' : { driverId, nowMs }
  );

  // Load cached data on mount, but discard stale caches older than 2 days
  useEffect(() => {
    let cancelled = false;
    async function loadCache() {
      try {
        const syncTime = await storage.getString(LAST_SYNC_KEY);
        if (cancelled) return;
        const syncMs = syncTime ? parseInt(syncTime, 10) : 0;
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

        if (syncMs && Date.now() - syncMs > twoDaysMs) {
          await storage.delete(LOADS_CACHE_KEY);
          await storage.delete(LAST_SYNC_KEY);
        } else {
          const cached = await storage.getString(LOADS_CACHE_KEY);
          if (cancelled) return;
          if (cached) {
            setCachedLoads(JSON.parse(cached));
          }
          if (syncMs) setLastSyncTime(syncMs);
        }
      } catch (e) {
        console.error('Failed to load cached loads:', e);
      }
      if (!cancelled) setCacheLoaded(true);
    }
    loadCache();
    return () => { cancelled = true; };
  }, []);

  // Cache loads when we get fresh data
  useEffect(() => {
    let cancelled = false;
    async function saveCache() {
      if (loads && loads.length >= 0) {
        const now = Date.now();
        try {
          await storage.set(LOADS_CACHE_KEY, JSON.stringify(loads));
          await storage.set(LAST_SYNC_KEY, String(now));
          if (cancelled) return;
          setCachedLoads(loads);
          setLastSyncTime(now);
        } catch (e) {
          console.error('Failed to cache loads:', e);
        }
      }
    }
    saveCache();
    return () => { cancelled = true; };
  }, [loads]);

  // Manual refetch function — clear timeout on unmount
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = useCallback(async () => {
    setIsRefetching(true);
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      setIsRefetching(false);
    }, 1000);
  }, []);

  // Clean up refetch timer on unmount
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  // Determine what data to return
  const displayLoads = isOffline ? (cachedLoads ?? []) : (loads ?? cachedLoads ?? []);
  const isLoading = !cacheLoaded || (isConnected !== false && loads === undefined && !cachedLoads);

  return {
    loads: displayLoads,
    isLoading,
    isRefetching,
    refetch,
    isOffline,
    isCached: isOffline && cachedLoads !== null,
    lastSyncTime,
  };
}
