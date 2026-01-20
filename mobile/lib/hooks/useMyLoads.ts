import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { useEffect, useState, useCallback } from 'react';
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

  // Fetch from Convex (only when online and we have a driverId)
  const shouldSkip = !driverId || isOffline === true;
  const loads = useQuery(
    api.driverMobile.getMyAssignedLoads,
    shouldSkip ? 'skip' : { driverId }
  );

  // Load cached data on mount
  useEffect(() => {
    async function loadCache() {
      try {
        const cached = await storage.getString(LOADS_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          setCachedLoads(parsed);
        }
        const syncTime = await storage.getString(LAST_SYNC_KEY);
        if (syncTime) {
          setLastSyncTime(parseInt(syncTime, 10));
        }
      } catch (e) {
        console.error('Failed to load cached loads:', e);
      }
      setCacheLoaded(true);
    }
    loadCache();
  }, []);

  // Cache loads when we get fresh data
  useEffect(() => {
    async function saveCache() {
      if (loads && loads.length >= 0) {
        const now = Date.now();
        try {
          await storage.set(LOADS_CACHE_KEY, JSON.stringify(loads));
          await storage.set(LAST_SYNC_KEY, String(now));
          setCachedLoads(loads);
          setLastSyncTime(now);
        } catch (e) {
          console.error('Failed to cache loads:', e);
        }
      }
    }
    saveCache();
  }, [loads]);

  // Manual refetch function
  const refetch = useCallback(async () => {
    setIsRefetching(true);
    // The query will automatically refetch when dependencies change
    // We just need to wait a bit and update the state
    setTimeout(() => {
      setIsRefetching(false);
    }, 1000);
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
