import { useEffect, useRef } from 'react';
import { useConvexAuthState } from '../convex';
import { trackQueryAuthFailure } from '../analytics';

/**
 * Tracks when a Convex query returns empty/default results while the frontend
 * believes auth is valid. This catches the silent backend auth failures where
 * requireCarrierAuth returns null and the query returns [] or a zeroed object.
 *
 * Usage:
 *   const loads = useQuery(api.carrierMobile.getActiveLoads, ...);
 *   useQueryHealth('getActiveLoads', loads, (data) => data.length === 0);
 */
export function useQueryHealth<T>(
  queryName: string,
  data: T | undefined,
  isEmpty: (data: T) => boolean,
) {
  const { isAuthenticated } = useConvexAuthState();
  const hadDataRef = useRef(false);
  const reportedRef = useRef(false);

  useEffect(() => {
    if (data === undefined) {
      reportedRef.current = false;
      return;
    }

    if (!isEmpty(data)) {
      hadDataRef.current = true;
      reportedRef.current = false;
      return;
    }

    // Data is empty. If we previously had data AND auth claims to be valid,
    // this is likely a backend auth failure (token expired server-side).
    if (hadDataRef.current && isAuthenticated && !reportedRef.current) {
      reportedRef.current = true;
      trackQueryAuthFailure(queryName, {
        had_data_before: true,
        is_authenticated: isAuthenticated,
      });
    }
  }, [data, isAuthenticated, queryName, isEmpty]);
}
