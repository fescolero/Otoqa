/**
 * useBootstrap — orchestrates auth + essential queries for the (app)
 * layout. Owns:
 *
 *   • Persisted app-mode (driver | owner) in AsyncStorage. We DON'T
 *     auto-select role from storage — carriers should always see the
 *     role-selection screen on sign-in.
 *   • Live `getUserRoles` query (skip-guarded on Convex auth) with a
 *     last-known cache so transient undefined states (token refresh,
 *     reactive re-subscription) don't flash the "Checking permissions"
 *     screen.
 *   • Live `getMyProfile` query for drivers, also with a last-known
 *     cache. Driver-id is forwarded so owner-operators are found by
 *     direct lookup instead of phone-number matching.
 *   • Live `getActiveSession` query — drives the "must scan a truck
 *     before any driver work" gate. Skip-guarded on profile._id so we
 *     don't fire pre-auth or for owner-only users.
 *   • Auto-select role for single-role users (the picker is only
 *     meaningful when both roles are available).
 *   • Auto-switch when profile/org disappears mid-session — owner
 *     users with no carrier org fall back to driver, and vice versa.
 *
 * MUST be called above any conditional return in the layout. The
 * underlying `useQuery`/`useMutation`/`useState` hooks need a stable
 * call order — see the hoisting comment on `useRegisterPushToken`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useQuery } from 'convex/react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { useConvexAuthState } from '../convex';

const MODE_STORAGE_KEY = '@app_mode_selection';

export type AppMode = 'driver' | 'owner';

export function useBootstrap() {
  const { isSignedIn, isLoaded: clerkLoaded, userId, signOut } = useAuth();
  const { user } = useUser();
  const convexAuth = useConvexAuthState();

  const [mode, setModeState] = useState<AppMode>('driver');
  const [hasSelectedRole, setHasSelectedRole] = useState(false);
  const [isLoadingStoredMode, setIsLoadingStoredMode] = useState(true);

  // Wrap setMode to persist to AsyncStorage.
  const setMode = useCallback(async (newMode: AppMode) => {
    setModeState(newMode);
    try {
      await AsyncStorage.setItem(
        MODE_STORAGE_KEY,
        JSON.stringify({ mode: newMode, hasSelected: true }),
      );
    } catch (e) {
      console.warn('Failed to save mode to storage:', e);
    }
  }, []);

  // Load persisted mode on mount — but DON'T auto-select role.
  // Carriers should always see the role-selection screen on sign-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(MODE_STORAGE_KEY);
        if (cancelled) return;
        if (stored) {
          const { mode: storedMode } = JSON.parse(stored);
          if (storedMode) {
            setModeState(storedMode);
          }
        }
      } catch (e) {
        console.warn('Failed to load mode from storage:', e);
      } finally {
        if (!cancelled) setIsLoadingStoredMode(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Clerk legacy org id (drives owner-side queries when WorkOS isn't wired up).
  const clerkOrgId = user?.organizationMemberships?.[0]?.organization?.id;

  // Live roles. Cached so transient undefined states don't flash a spinner.
  const userRolesLive = useQuery(
    api.carrierMobile.getUserRoles,
    convexAuth.isAuthenticated && userId
      ? { clerkUserId: userId, clerkOrgId: clerkOrgId }
      : 'skip',
  );
  const cachedRolesRef = useRef(userRolesLive);
  if (userRolesLive !== undefined) {
    cachedRolesRef.current = userRolesLive;
  }
  const userRoles = userRolesLive ?? cachedRolesRef.current;

  // Driver profile. Pass driverId from getUserRoles so owner-operators are
  // found by direct lookup instead of relying on phone-number matching.
  const profileLive = useQuery(
    api.driverMobile.getMyProfile,
    convexAuth.isAuthenticated && hasSelectedRole && (userRoles?.isDriver || mode === 'driver')
      ? { driverId: (userRoles?.driverId ?? undefined) as Id<'drivers'> | undefined }
      : 'skip',
  );
  const cachedProfileRef = useRef(profileLive);
  if (profileLive !== undefined) {
    cachedProfileRef.current = profileLive;
  }
  const profile = profileLive ?? cachedProfileRef.current;

  // Active driver session — drives the "must scan a truck before any
  // driver work" gate. Skip-guarded on profile._id so we don't fire
  // pre-auth or for owner-only users.
  const activeSession = useQuery(
    api.driverSessions.getActiveSession,
    profile?._id ? { driverId: profile._id as Id<'drivers'> } : 'skip',
  );

  // Available modes.
  const canBeDriver = userRoles?.isDriver ?? false;
  const canBeOwner = userRoles?.isCarrierOwner ?? false;
  const canSwitchModes = canBeDriver && canBeOwner;

  // Carrier org info is returned directly from userRoles (no separate query).
  // Memoized so the auto-switch effect's dependency array doesn't churn on
  // every render — the object identity only changes when userRoles change.
  const carrierOrg = useMemo(() => (
    userRoles?.isCarrierOwner ? {
      _id: userRoles.carrierOrgConvexId,
      name: userRoles.carrierOrgName || 'Carrier',
      clerkOrgId: userRoles.carrierOrgId,
      workosOrgId: userRoles.carrierOrgId,
      orgType: userRoles.orgType,
    } : null
  ), [userRoles]);

  // Auto-select role ONLY if user has just one role. Single-role users
  // should never see the picker — they go straight to home.
  const isRolesLoading = userRoles === undefined;
  useEffect(() => {
    if (!userRoles || isRolesLoading || hasSelectedRole) return;
    if (userRoles.isDriver && !userRoles.isCarrierOwner) {
      setMode('driver');
      setHasSelectedRole(true);
    } else if (!userRoles.isDriver && userRoles.isCarrierOwner) {
      setMode('owner');
      setHasSelectedRole(true);
    }
  }, [userRoles, isRolesLoading, hasSelectedRole, setMode]);

  // Auto-switch modes when profile/org disappears mid-session.
  useEffect(() => {
    if (mode === 'driver' && profile === null && canBeOwner) {
      console.log('Driver profile not found, switching to owner mode');
      setMode('owner');
    }
    if (mode === 'owner' && (!carrierOrg || !carrierOrg._id) && canBeDriver && profile) {
      console.log('Carrier org not found, switching to driver mode');
      setMode('driver');
    }
  }, [mode, profile, carrierOrg, canBeOwner, canBeDriver, setMode]);

  return {
    // Auth
    isSignedIn,
    clerkLoaded,
    userId,
    user,
    signOut,
    convexAuth,
    clerkOrgId,
    // Mode state
    mode,
    setMode,
    hasSelectedRole,
    setHasSelectedRole,
    isLoadingStoredMode,
    // Live data
    userRoles,
    profile,
    activeSession,
    carrierOrg,
    // Derived flags
    canBeDriver,
    canBeOwner,
    canSwitchModes,
    isRolesLoading,
  };
}

export { MODE_STORAGE_KEY };
