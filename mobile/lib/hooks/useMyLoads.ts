import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { useEffect, useState, useCallback, useRef } from 'react';
import { storage } from '../storage';
import { useNetworkStatus } from './useNetworkStatus';

// ============================================
// HOOK: GET DRIVER'S ASSIGNED LOADS (calendar mode)
//
// Driver home is now always calendar mode. Yesterday / Today / Tomorrow tabs
// drive filtering in the UI; this hook only fetches a rolling 4-day window
// around now and hands the array back flat.
//
// Session start / end happens on the More tab, not Home. Shift status is
// implicit from the load's own status fields (trackingStatus / status) and
// from the safety-net server-side: any leg currently ACTIVE for this driver
// flows through regardless of its firstStopDate, so a multi-day trip that
// started yesterday still shows up today and pins to the Today tab.
//
// SQLite-backed cache persists the last successful response so the home
// screen has something to render when offline.
//
// NOTE: getSessionLoads backend function is kept for now but unused here;
// pruning tracked as a follow-up.
// ============================================

const LOADS_CACHE_KEY = 'cached_loads';
const LAST_SYNC_KEY = 'last_sync_time';

export function useMyLoads(driverId: Id<'drivers'> | null) {
  const { connectionQuality } = useNetworkStatus();
  const [cachedLoads, setCachedLoads] = useState<any[] | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [isRefetching, setIsRefetching] = useState(false);

  // Round to nearest minute so the query arg doesn't change every millisecond.
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  const isOffline = connectionQuality !== 'good';
  const skip = !driverId || isOffline;

  const calendarLoads = useQuery(
    api.driverMobile.getMyAssignedLoads,
    skip ? 'skip' : { driverId: driverId!, nowMs },
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        const sync = await storage.getString(LAST_SYNC_KEY);
        const syncMs = sync ? parseInt(sync, 10) : 0;
        if (syncMs && Date.now() - syncMs > twoDaysMs) {
          await storage.delete(LOADS_CACHE_KEY);
          await storage.delete(LAST_SYNC_KEY);
        } else if (syncMs) {
          const cached = await storage.getString(LOADS_CACHE_KEY);
          if (!cancelled && cached) setCachedLoads(JSON.parse(cached));
          if (!cancelled) setLastSyncTime(syncMs);
        }
      } catch (e) {
        console.error('Failed to load cached loads:', e);
      }
      if (!cancelled) setCacheLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (calendarLoads && calendarLoads.length >= 0) {
        const now = Date.now();
        try {
          await storage.set(LOADS_CACHE_KEY, JSON.stringify(calendarLoads));
          await storage.set(LAST_SYNC_KEY, String(now));
          if (cancelled) return;
          setCachedLoads(calendarLoads);
          setLastSyncTime(now);
        } catch (e) {
          console.error('Failed to cache loads:', e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [calendarLoads]);

  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = useCallback(async () => {
    setIsRefetching(true);
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => setIsRefetching(false), 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  const loads: any[] = isOffline ? cachedLoads ?? [] : calendarLoads ?? cachedLoads ?? [];

  const isLoading =
    !cacheLoaded ||
    (connectionQuality === 'good' && calendarLoads === undefined && !cachedLoads);

  const isCached = isOffline && cachedLoads !== null;
  const hasNoData = cacheLoaded && loads.length === 0 && isOffline;

  return {
    loads,
    isLoading,
    isRefetching,
    refetch,
    isOffline,
    isCached,
    lastSyncTime,
    hasNoData,
  };
}
