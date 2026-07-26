/**
 * useOwnerModeEnabled — split-plan §6 driver cleanup, release N.
 *
 * Reactive read of the `owner_mode_in_driver_app` flag that gates the
 * driver app's owner tree during the Dispatch-app migration window.
 *
 * Resolution order:
 *   1. Live Convex subscription — flipping the flag lands within seconds
 *      on every connected client (same kill-switch path as ar/fcm flags;
 *      the subscription is shared with usePushWake's, Convex dedupes).
 *   2. AsyncStorage cache from a previous launch (offline boot).
 *   3. In-code default TRUE — a cold cache or unreachable server can
 *      never lock a user out of owner mode; only an explicit 'false'
 *      from the server does.
 *
 * Must be called unconditionally (above every conditional return in the
 * layout) — same hook-order rule as the other bootstrap hooks.
 */
import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { FLAG_OWNER_MODE_IN_DRIVER_APP, getFlagBool } from '../feature-flags';

export function useOwnerModeEnabled(isAuthenticated: boolean): boolean {
  const [cached, setCached] = useState(true);
  useEffect(() => {
    let alive = true;
    getFlagBool(FLAG_OWNER_MODE_IN_DRIVER_APP, true).then((v) => {
      if (alive) setCached(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const live = useQuery(api.featureFlags.getForOrg, isAuthenticated ? {} : 'skip');
  if (live !== undefined) {
    // Only an explicit server-side 'false' disables owner mode.
    return live[FLAG_OWNER_MODE_IN_DRIVER_APP] !== 'false';
  }
  return cached;
}
