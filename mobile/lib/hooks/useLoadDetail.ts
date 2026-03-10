import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { useEffect, useState } from 'react';
import { storage } from '../storage';
import { useNetworkStatus } from './useNetworkStatus';

// ============================================
// HOOK: GET LOAD DETAIL WITH STOPS
// With offline caching support.
// Skips Convex query on poor/offline connections to avoid hanging.
// ============================================

function getCacheKey(loadId: string) {
  return `cached_load_${loadId}`;
}

export function useLoadDetail(
  loadId: Id<'loadInformation'> | null,
  driverId: Id<'drivers'> | null
) {
  const { connectionQuality } = useNetworkStatus();
  const [cachedData, setCachedData] = useState<{ load: any; stops: any[] } | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // Only fetch from Convex when connection is good
  const shouldSkip = !loadId || !driverId || connectionQuality !== 'good';
  const data = useQuery(
    api.driverMobile.getLoadWithStops,
    shouldSkip ? 'skip' : { loadId, driverId }
  );

  // Load cached data on mount or when loadId changes
  useEffect(() => {
    async function loadCache() {
      if (!loadId) {
        setCacheLoaded(true);
        return;
      }
      try {
        const cached = await storage.getString(getCacheKey(loadId));
        if (cached) {
          const parsed = JSON.parse(cached);
          setCachedData(parsed);
        }
      } catch (e) {
        console.error('Failed to load cached load detail:', e);
      }
      setCacheLoaded(true);
    }
    loadCache();
  }, [loadId]);

  // Cache data when we get fresh data from server
  useEffect(() => {
    async function saveCache() {
      if (loadId && data?.load) {
        try {
          await storage.set(getCacheKey(loadId), JSON.stringify(data));
          setCachedData(data);
        } catch (e) {
          console.error('Failed to cache load detail:', e);
        }
      }
    }
    saveCache();
  }, [loadId, data]);

  // On poor/offline: show cached data immediately. On good: prefer live data, fall back to cache.
  const displayData = connectionQuality !== 'good' ? cachedData : (data ?? cachedData);
  const isLoading = !cacheLoaded || (connectionQuality === 'good' && data === undefined && !cachedData);
  const isOffline = connectionQuality !== 'good';

  return {
    load: displayData?.load ?? null,
    stops: displayData?.stops ?? [],
    isLoading,
    isOffline,
    isCached: isOffline && cachedData !== null,
    hasNoData: cacheLoaded && !displayData && isOffline,
  };
}
