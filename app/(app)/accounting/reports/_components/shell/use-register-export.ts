'use client';

import { useEffect, useRef } from 'react';

/**
 * Lets a view expose its "export current data to CSV" action to the shell's
 * header button. The active view registers on mount and clears on unmount; the
 * registered wrapper always calls the latest closure via a ref, so it never
 * exports stale data. `register` must be stable (useCallback in the dashboard).
 */
export function useRegisterExport(register: (fn: (() => void) | null) => void, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    register(() => ref.current());
    return () => register(null);
  }, [register]);
}
