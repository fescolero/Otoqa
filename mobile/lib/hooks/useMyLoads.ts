import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { useEffect, useState, useCallback, useRef } from 'react';
import { storage } from '../storage';
import { useNetworkStatus } from './useNetworkStatus';

// ============================================
// HOOK: GET DRIVER'S ASSIGNED LOADS (session-aware)
//
// Two modes:
//   - Session mode: driver has tapped Start Shift. We query getSessionLoads
//     and return bucketed In Progress / Up Next / Completed-this-session.
//     Calendar tabs are hidden in this mode (consumer's responsibility).
//   - Calendar mode (legacy): no active session. We query the existing
//     getMyAssignedLoads with the rolling 4-day window. Yesterday/Today/
//     Tomorrow tabs apply.
//
// Same SQLite cache behavior in both modes — last successful query result
// is persisted so the home screen has something to render offline.
// ============================================

const LOADS_CACHE_KEY = 'cached_loads';
const LAST_SYNC_KEY = 'last_sync_time';
const SESSION_LOADS_CACHE_KEY = 'cached_session_loads';
const SESSION_LOADS_LAST_SYNC_KEY = 'cached_session_loads_sync';

export type SessionLoadsBuckets = {
  inProgress: any[];
  upNext: any[];
  completedThisSession: any[];
};

export function useMyLoads(driverId: Id<'drivers'> | null) {
  const { connectionQuality } = useNetworkStatus();
  const [cachedLoads, setCachedLoads] = useState<any[] | null>(null);
  const [cachedSessionLoads, setCachedSessionLoads] = useState<SessionLoadsBuckets | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [isRefetching, setIsRefetching] = useState(false);

  // Round to nearest minute so the query arg doesn't change every millisecond
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  const isOffline = connectionQuality !== 'good';
  const baseSkip = !driverId || isOffline;

  // Always probe for an active session — cheap (1-row index lookup) and the
  // result drives which loads query we run. Skipped on bad connection so we
  // don't hang.
  const activeSession = useQuery(
    api.driverSessions.getActiveSession,
    baseSkip ? 'skip' : { driverId: driverId ?? undefined }
  );

  const sessionId = activeSession?._id ?? null;
  const isSessionMode = sessionId !== null;

  // Calendar mode query (legacy). Skipped when session is active.
  const calendarLoads = useQuery(
    api.driverMobile.getMyAssignedLoads,
    baseSkip || isSessionMode || activeSession === undefined
      ? 'skip'
      : { driverId: driverId!, nowMs }
  );

  // Session mode query. Skipped when no session.
  const sessionLoads = useQuery(
    api.driverMobile.getSessionLoads,
    !sessionId || baseSkip ? 'skip' : { sessionId, nowMs }
  );

  // Cache hydration on mount. Loads both caches; only the relevant one
  // gets used in render below.
  useEffect(() => {
    let cancelled = false;
    async function loadCache() {
      try {
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        const calSync = await storage.getString(LAST_SYNC_KEY);
        const calSyncMs = calSync ? parseInt(calSync, 10) : 0;
        if (calSyncMs && Date.now() - calSyncMs > twoDaysMs) {
          await storage.delete(LOADS_CACHE_KEY);
          await storage.delete(LAST_SYNC_KEY);
        } else if (calSyncMs) {
          const cached = await storage.getString(LOADS_CACHE_KEY);
          if (!cancelled && cached) setCachedLoads(JSON.parse(cached));
          if (!cancelled) setLastSyncTime(calSyncMs);
        }

        const sessSync = await storage.getString(SESSION_LOADS_LAST_SYNC_KEY);
        const sessSyncMs = sessSync ? parseInt(sessSync, 10) : 0;
        if (sessSyncMs && Date.now() - sessSyncMs > twoDaysMs) {
          await storage.delete(SESSION_LOADS_CACHE_KEY);
          await storage.delete(SESSION_LOADS_LAST_SYNC_KEY);
        } else if (sessSyncMs) {
          const cached = await storage.getString(SESSION_LOADS_CACHE_KEY);
          if (!cancelled && cached) setCachedSessionLoads(JSON.parse(cached));
          if (!cancelled && (!lastSyncTime || sessSyncMs > lastSyncTime)) {
            setLastSyncTime(sessSyncMs);
          }
        }
      } catch (e) {
        console.error('Failed to load cached loads:', e);
      }
      if (!cancelled) setCacheLoaded(true);
    }
    loadCache();
    return () => {
      cancelled = true;
    };
    // Run once on mount; lastSyncTime in deps would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist calendar-mode results.
  useEffect(() => {
    let cancelled = false;
    async function saveCache() {
      if (calendarLoads && calendarLoads.length >= 0) {
        const now = Date.now();
        try {
          await storage.set(LOADS_CACHE_KEY, JSON.stringify(calendarLoads));
          await storage.set(LAST_SYNC_KEY, String(now));
          if (cancelled) return;
          setCachedLoads(calendarLoads);
          setLastSyncTime(now);
        } catch (e) {
          console.error('Failed to cache calendar loads:', e);
        }
      }
    }
    saveCache();
    return () => {
      cancelled = true;
    };
  }, [calendarLoads]);

  // Persist session-mode results.
  useEffect(() => {
    let cancelled = false;
    async function saveCache() {
      if (sessionLoads) {
        const now = Date.now();
        try {
          await storage.set(SESSION_LOADS_CACHE_KEY, JSON.stringify(sessionLoads));
          await storage.set(SESSION_LOADS_LAST_SYNC_KEY, String(now));
          if (cancelled) return;
          setCachedSessionLoads(sessionLoads);
          setLastSyncTime(now);
        } catch (e) {
          console.error('Failed to cache session loads:', e);
        }
      }
    }
    saveCache();
    return () => {
      cancelled = true;
    };
  }, [sessionLoads]);

  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = useCallback(async () => {
    setIsRefetching(true);
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      setIsRefetching(false);
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  // Resolve display data per mode. Session takes precedence when known.
  const sessionLoadsDisplay: SessionLoadsBuckets | null = isSessionMode
    ? sessionLoads ?? cachedSessionLoads
    : null;

  const calendarLoadsDisplay: any[] = isSessionMode
    ? []
    : isOffline
      ? cachedLoads ?? []
      : calendarLoads ?? cachedLoads ?? [];

  // Flattened loads array — supports legacy consumers that only know about
  // .loads[]. Session mode flattens all three buckets.
  const flattenedLoads: any[] = isSessionMode
    ? sessionLoadsDisplay
      ? [
          ...sessionLoadsDisplay.inProgress,
          ...sessionLoadsDisplay.upNext,
          ...sessionLoadsDisplay.completedThisSession,
        ]
      : []
    : calendarLoadsDisplay;

  const isLoading =
    !cacheLoaded ||
    (connectionQuality === 'good' &&
      activeSession === undefined) ||
    (connectionQuality === 'good' &&
      isSessionMode &&
      sessionLoads === undefined &&
      !cachedSessionLoads) ||
    (connectionQuality === 'good' &&
      !isSessionMode &&
      calendarLoads === undefined &&
      !cachedLoads);

  const isCached =
    isOffline &&
    (isSessionMode ? cachedSessionLoads !== null : cachedLoads !== null);

  const hasNoData =
    cacheLoaded &&
    flattenedLoads.length === 0 &&
    isOffline;

  return {
    // Mode discrimination for the home screen.
    mode: isSessionMode ? ('session' as const) : ('calendar' as const),
    activeSession: activeSession ?? null,
    // Session-mode bucketed data (null in calendar mode).
    sessionLoads: sessionLoadsDisplay,
    // Calendar-mode array (empty in session mode).
    loads: flattenedLoads,
    // Status flags shared across both modes.
    isLoading,
    isRefetching,
    refetch,
    isOffline,
    isCached,
    lastSyncTime,
    hasNoData,
  };
}
