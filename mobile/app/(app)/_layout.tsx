import { Redirect, Stack, useRouter } from 'expo-router';
import {
  View,
  StyleSheet,
  Text,
  Pressable,
} from 'react-native';
import { LoadingRingScreen } from '../../lib/otoqa-loader';
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, borderRadius } from '../../lib/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CompleteDriverProfileScreen from './owner/complete-driver-profile';
import RoleSwitchScreen from './role-switch';
import { useRegisterPushToken } from '../../lib/hooks/useRegisterPushToken';
import { performSignOut } from '../../lib/logout';
import { useAutoUpdate } from '../../lib/auto-update';
import {
  resetUser,
  trackRoleSelected,
  trackLoadingGateTimeout,
  trackLoadingGateResolved,
  trackLoadingGateRetry,
  trackAppSessionHealth,
  type LoadingGate,
} from '../../lib/analytics';
import { useBootstrap, MODE_STORAGE_KEY } from '../../lib/hooks/useBootstrap';
import { usePermissionGates } from '../../lib/hooks/usePermissionGates';
import { usePushWake } from '../../lib/hooks/usePushWake';
import { useLocationService } from '../../lib/hooks/useLocationService';
import { useAnalyticsInit } from '../../lib/hooks/useAnalyticsInit';

const GATE_TIMEOUT_MS = 12_000;

function useLoadingGate(gate: LoadingGate, isWaiting: boolean, deps?: Record<string, unknown>) {
  const startRef = useRef<number | null>(null);
  const timedOutRef = useRef(false);
  const resolvedRef = useRef(false);
  const [isTimedOut, setIsTimedOut] = useState(false);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (isWaiting) {
      if (startRef.current === null) {
        startRef.current = Date.now();
        timedOutRef.current = false;
        resolvedRef.current = false;
      }

      const timer = setTimeout(() => {
        if (!resolvedRef.current) {
          timedOutRef.current = true;
          setIsTimedOut(true);
          trackLoadingGateTimeout(gate, Date.now() - (startRef.current ?? Date.now()), deps);
        }
      }, GATE_TIMEOUT_MS);

      return () => clearTimeout(timer);
    } else if (startRef.current !== null && !resolvedRef.current) {
      resolvedRef.current = true;
      const elapsed = Date.now() - startRef.current;
      trackLoadingGateResolved(gate, elapsed, { was_stuck: timedOutRef.current, ...deps });
      trackAppSessionHealth({
        gate_reached: gate,
        total_elapsed_ms: elapsed,
        was_stuck: timedOutRef.current,
        recovered: timedOutRef.current,
      });
      startRef.current = null;
      timedOutRef.current = false;
      setIsTimedOut(false);
    }
  }, [isWaiting]);

  const retry = useCallback(() => {
    retryCountRef.current += 1;
    trackLoadingGateRetry(gate, retryCountRef.current, deps);
    startRef.current = Date.now();
    timedOutRef.current = false;
    resolvedRef.current = false;
    setIsTimedOut(false);
  }, [gate]);

  return { isTimedOut, retry, retryCount: retryCountRef.current };
}

// ============================================
// APP LAYOUT - Dark Theme Floating Nav
// Supports both Driver and Carrier Owner modes
// ============================================

// User roles context
interface UserRoles {
  isDriver: boolean;
  driverId: string | null;
  driverOrgId: string | null;
  driverOrgName: string | null;
  isCarrierOwner: boolean;
  carrierOrgId: string | null;
  carrierOrgName: string | null;
  orgType: string | null;
  isBroker: boolean;
}

interface AppModeContextType {
  mode: 'driver' | 'owner';
  setMode: (mode: 'driver' | 'owner') => void | Promise<void>;
  roles: UserRoles | null;
  canSwitchModes: boolean;
}

const AppModeContext = createContext<AppModeContextType>({
  mode: 'driver',
  setMode: () => {},
  roles: null,
  canSwitchModes: false,
});

export function useAppMode() {
  return useContext(AppModeContext);
}

// Driver context to share profile across screens
interface TruckInfo {
  _id: Id<'trucks'>;
  unitId: string;
  make?: string;
  model?: string;
}

interface DriverContextType {
  driverId: Id<'drivers'> | null;
  driverName: string;
  organizationId: string | null;
  truck: TruckInfo | null;
  isLoading: boolean;
}

const DriverContext = createContext<DriverContextType>({
  driverId: null,
  driverName: '',
  organizationId: null,
  truck: null,
  isLoading: true,
});

export function useDriver() {
  return useContext(DriverContext);
}

// Carrier Owner context
interface CarrierOwnerContextType {
  carrierOrgId: string | null;       // Convex document ID (for drivers table)
  carrierExternalOrgId: string | null; // clerkOrgId/workosOrgId (for loadCarrierAssignments)
  orgName: string;
  orgType: string | null;
  isLoading: boolean;
}

const CarrierOwnerContext = createContext<CarrierOwnerContextType>({
  carrierOrgId: null,
  carrierExternalOrgId: null,
  orgName: '',
  orgType: null,
  isLoading: true,
});

export function useCarrierOwner() {
  return useContext(CarrierOwnerContext);
}

export default function AppLayout() {
  // Auth + persisted mode + live queries (roles / profile / active session)
  // + auto-mode-switch logic. All hooks are called unconditionally inside.
  const boot = useBootstrap();
  const {
    isSignedIn, clerkLoaded, userId, user, signOut,
    convexAuth, clerkOrgId,
    mode, setMode, hasSelectedRole, setHasSelectedRole, isLoadingStoredMode,
    userRoles, profile, activeSession, carrierOrg,
    canBeDriver, canBeOwner, canSwitchModes, isRolesLoading,
  } = boot;

  // Permission prompts (camera/location/notifications + ACTIVITY_RECOGNITION).
  usePermissionGates();

  // Sole reload-decision point for downloaded OTA bundles. Inert until
  // expo-updates flips `isUpdatePending`, then reloads at the next safe
  // boundary (foreground transition with no active driver session). See
  // `mobile/lib/auto-update.ts` for the full rationale + safety gates.
  useAutoUpdate();

  // Register the Expo push token once the driver is hydrated. CRITICAL:
  // this call must sit ABOVE every conditional `return` below — if it's
  // called in a branch that's skipped on one render (e.g. the role-
  // switch gate) and reached on another (after hasSelectedRole flips),
  // React's hook-counter changes and throws "Rendered more hooks than
  // during the previous render." That's exactly what broke the Continue
  // button: state flipped, the next render took the non-gate branch,
  // and React bailed out mid-commit with no visual change. The hook
  // no-ops when driverId is null so it's safe to call every render.
  useRegisterPushToken(profile?._id ?? null);

  // Phase 1c FCM wake wiring + token-refresh + feature flags + motion
  // service. Same hoisting rule as useRegisterPushToken — must sit
  // above any conditional return.
  usePushWake(activeSession ?? null);

  // Location-tracking lifecycle: resume-on-mount, foreground flush, and
  // orphan-tracking self-heal. Same hoisting rule.
  useLocationService({
    mode,
    driverId: profile?._id ?? null,
    activeSession: activeSession ?? null,
  });

  // Check if owner-operator needs to complete driver profile.
  const needsDriverProfileResult = useQuery(
    api.carrierMobile.needsDriverProfile,
    mode === 'owner' && userRoles?.isCarrierOwner && userRoles.isOwnerOperator && userRoles.carrierOrgConvexId
      ? { carrierOrgId: userRoles.carrierOrgConvexId }
      : 'skip',
  );
  const needsDriverProfileOnboarding = needsDriverProfileResult?.needsProfile === true;

  const isProfileLoading = mode === 'driver' && hasSelectedRole && userRoles?.isDriver && profile === undefined;
  const isCarrierOrgLoading = mode === 'owner' && hasSelectedRole && userRoles === undefined;
  // For drivers, also wait for the active-session query before rendering
  // any (app) screen — otherwise the default Stack child (driver-tabs)
  // flashes for a frame before our navigation effect can route the user
  // to /switch-truck. Profile-with-id is required because activeSession
  // is skip-guarded on profile?._id; if profile resolves to null (rare)
  // we don't block.
  const isActiveSessionLoading =
    mode === 'driver' &&
    hasSelectedRole &&
    !!profile?._id &&
    activeSession === undefined;

  // Loading gate monitors — track how long each gate takes and fire PostHog events on timeout
  const convexAuthGate = useLoadingGate('convex_auth', convexAuth.isLoading && !!isSignedIn);
  const rolesGate = useLoadingGate('user_roles', isRolesLoading && convexAuth.isAuthenticated);
  const profileGate = useLoadingGate('driver_profile', !!isProfileLoading);
  const carrierOrgGate = useLoadingGate('carrier_org', !!isCarrierOrgLoading);

  // Identify user in PostHog once roles are known and mode is selected.
  useAnalyticsInit({
    userId,
    user,
    userRoles,
    hasSelectedRole,
    clerkOrgId,
  });

  // Handle sign out - clear stored mode
  const handleSignOut = async () => {
    try {
      await AsyncStorage.removeItem(MODE_STORAGE_KEY);
    } catch (e) {
      console.warn('Failed to clear mode from storage:', e);
    }
    resetUser();
    await performSignOut(signOut, '(app)_layout_handoff');
  };

  // Get router for initial-screen navigation
  const router = useRouter();
  // Tracks which mode we've already done the one-shot landing nav for.
  // Re-fires only when the mode itself changes (driver↔owner). Within a
  // mode, we never override the user's own navigation — e.g. ending a
  // shift in /(driver-tabs)/more must NOT bounce them to /switch-truck;
  // they may want to browse loads first, and Start shift will route to
  // the scanner when they're ready.
  const initialNavFiredForModeRef = useRef<'driver' | 'owner' | null>(null);

  // Compute the initial landing destination per mode.
  //   • owner mode → /(app)/owner (need carrierOrg loaded)
  //   • driver mode + active session → /(app)/(driver-tabs)
  //   • driver mode + no active session → /switch-truck (force a fresh
  //     scan — verify.tsx defers to us so the decision lives here)
  //   • driver mode + activeSession still loading → wait (the
  //     isActiveSessionLoading gate above shows the spinner)
  let desiredRoute: string | null = null;
  if (hasSelectedRole) {
    if (mode === 'owner' && carrierOrg?._id) {
      desiredRoute = '/(app)/owner';
    } else if (mode === 'driver') {
      if (activeSession === undefined) {
        desiredRoute = null;
      } else if (activeSession) {
        desiredRoute = '/(app)/(driver-tabs)';
      } else {
        desiredRoute = '/switch-truck';
      }
    }
  }

  useEffect(() => {
    if (!desiredRoute) return;
    // One-shot per mode. Subsequent activeSession flips inside a mode
    // (e.g. End shift) don't reroute the user — they continue navigating
    // the app under their own steam.
    if (initialNavFiredForModeRef.current === mode) return;
    initialNavFiredForModeRef.current = mode;
    router.navigate(desiredRoute as never);
  }, [desiredRoute, mode]);

  // Wait for Clerk to be ready and stored mode to load
  if (!clerkLoaded || isLoadingStoredMode) {
    return <LoadingRingScreen statusText="Loading…" subText="Hang tight" />;
  }

  if (!isSignedIn) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  // Wait for Convex auth setup
  if (convexAuth.isLoading) {
    if (convexAuthGate.isTimedOut) {
      return (
        <GateErrorScreen
          icon="cloud-offline-outline"
          title="Connection Slow"
          subtext="Having trouble connecting to the server."
          onRetry={() => { convexAuthGate.retry(); }}
          onSignOut={handleSignOut}
        />
      );
    }
    return <LoadingRingScreen statusText="Connecting to server…" subText="Hang tight" />;
  }

  // Show loading while fetching roles
  if (isRolesLoading) {
    if (rolesGate.isTimedOut) {
      return (
        <GateErrorScreen
          icon="shield-outline"
          title="Taking Longer Than Expected"
          subtext="Still checking your permissions. You can retry or sign out and try again."
          onRetry={() => { rolesGate.retry(); }}
          onSignOut={handleSignOut}
        />
      );
    }
    return <LoadingRingScreen statusText="Checking permissions…" subText="Hang tight" />;
  }

  // Post-sign-in role chooser — DUAL-ROLE USERS ONLY.
  //
  // Renders the v4-design `RoleSwitchScreen` inline, wrapped in the
  // AppModeContext + DriverContext providers it expects. `setMode` is
  // shadowed with a wrapper that also flips `hasSelectedRole` so the
  // next render falls through to the Stack rather than looping back
  // here. The screen's own `router.replace('/(app)'|'/(app)/owner')`
  // call is a no-op in this code path (we're already at /(app) and
  // the mode flip drives what the Stack renders) — safe to leave as-is.
  //
  // Guarded on `canSwitchModes` (= isDriver && isCarrierOwner). Single-
  // role users (driver-only OR owner-only) get auto-resolved by the
  // useEffect above and skip this screen entirely — they go straight
  // home because they have no choice to make.
  if (!hasSelectedRole && canSwitchModes) {
    const displayName =
      user?.fullName ||
      (user?.firstName && user?.lastName
        ? `${user.firstName} ${user.lastName}`
        : user?.firstName) ||
      userRoles?.carrierOrgName ||
      'Driver';

    return (
      <AppModeContext.Provider
        value={{
          mode,
          setMode: async (selectedRole) => {
            trackRoleSelected(selectedRole);
            setHasSelectedRole(true);
            await setMode(selectedRole);
          },
          roles: userRoles,
          canSwitchModes,
        }}
      >
        <DriverContext.Provider
          value={{
            // Profile isn't loaded yet here (this gate fires before the
            // profile query settles), but RoleSwitchScreen only reads
            // driverName for the header — pass the Clerk-derived name.
            driverId: null,
            driverName: displayName,
            organizationId: null,
            truck: null,
            isLoading: false,
          }}
        >
          <RoleSwitchScreen />
        </DriverContext.Provider>
      </AppModeContext.Provider>
    );
  }

  // Show loading while fetching profile/org/session. Active-session
  // loading is critical for the /switch-truck-vs-/(driver-tabs) routing
  // decision — without this gate the default Stack child renders for
  // a frame before the navigation effect fires.
  if (isProfileLoading || isCarrierOrgLoading || isActiveSessionLoading) {
    const activeGate = isProfileLoading ? profileGate : carrierOrgGate;
    if (activeGate.isTimedOut) {
      return (
        <GateErrorScreen
          icon="person-outline"
          title="Profile Load Slow"
          subtext="Having trouble loading your profile data."
          onRetry={() => { activeGate.retry(); }}
          onSignOut={handleSignOut}
        />
      );
    }
    return <LoadingRingScreen statusText="Loading profile…" subText="Hang tight" />;
  }

  // Handle deleted organization (shows specific message with reason)
  if (userRoles?.orgStatus === 'deleted') {
    const deletedDate = userRoles.orgDeletedAt
      ? new Date(userRoles.orgDeletedAt).toLocaleDateString()
      : 'recently';

    return (
      <View style={styles.error}>
        <Ionicons name="close-circle" size={64} color={colors.destructive} />
        <Text style={styles.errorTitle}>Organization Deactivated</Text>
        <Text style={styles.errorText}>
          {userRoles.carrierOrgName ? `"${userRoles.carrierOrgName}" ` : 'Your carrier organization '}
          was deactivated on {deletedDate}.
        </Text>
        {userRoles.orgDeletionReason && (
          <Text style={styles.errorSubtext}>
            Reason: {userRoles.orgDeletionReason}
          </Text>
        )}
        <Text style={styles.errorSubtext}>
          If you believe this is an error, please contact support at support@otoqa.com
          or call 1-800-XXX-XXXX for assistance.
        </Text>
        <Pressable
          style={styles.errorButton}
          onPress={handleSignOut}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.errorButtonText}>Back to Sign In</Text>
        </Pressable>
      </View>
    );
  }

  // Handle case where user has no roles
  if (!canBeDriver && !canBeOwner) {
    return (
      <NotRegisteredScreen
        message="Your phone number is not registered as a driver or carrier owner in the system. Please contact your dispatcher or company administrator."
        onSignOut={handleSignOut}
      />
    );
  }

  // Handle driver mode when driver profile not found and can't switch
  if (mode === 'driver' && profile === null && !canBeOwner) {
    return (
      <NotRegisteredScreen
        message="Your phone number is not registered as a driver in the system. Please contact your dispatcher."
        onSignOut={handleSignOut}
      />
    );
  }

  // Handle owner mode when carrier org not found and can't switch
  if (mode === 'owner' && (!carrierOrg || !carrierOrg._id) && !canBeDriver) {
    return (
      <NotRegisteredScreen
        title="Organization Not Found"
        message="Your carrier organization is not set up yet. Please contact support to complete registration."
        onSignOut={handleSignOut}
      />
    );
  }

  // Build carrier owner context value
  // carrierOrgId = Convex document ID (used for drivers table queries)
  // carrierExternalOrgId = clerkOrgId/workosOrgId (used for loadCarrierAssignments queries)
  const carrierOwnerContextValue = {
    carrierOrgId: carrierOrg?._id || null,
    carrierExternalOrgId: userRoles?.carrierOrgId || null,
    orgName: carrierOrg?.name || '',
    orgType: carrierOrg?.orgType || null,
    isLoading: false,
  };


  const driverContextValue = profile ? {
    driverId: profile._id,
    driverName: `${profile.firstName} ${profile.lastName}`,
    organizationId: profile.organizationId,
    truck: profile.truck ?? null,
    isLoading: false,
  } : {
    driverId: null,
    driverName: '',
    organizationId: null,
    truck: null,
    isLoading: true,
  };

  if (mode === 'owner' && carrierOrg?._id && needsDriverProfileOnboarding) {
    return (
      <AppModeContext.Provider value={{ mode, setMode, roles: userRoles, canSwitchModes }}>
        <CarrierOwnerContext.Provider value={carrierOwnerContextValue}>
          <CompleteDriverProfileScreen />
        </CarrierOwnerContext.Provider>
      </AppModeContext.Provider>
    );
  }

  return (
    <AppModeContext.Provider
      value={{
        mode,
        setMode,
        roles: userRoles,
        canSwitchModes,
      }}
    >
      <CarrierOwnerContext.Provider value={carrierOwnerContextValue}>
        <DriverContext.Provider value={driverContextValue}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(driver-tabs)" />
            <Stack.Screen name="trip/[id]" />
            <Stack.Screen name="capture-photo" />
            <Stack.Screen name="switch-truck" />
            <Stack.Screen name="permissions" />
            <Stack.Screen name="notifications" />
            <Stack.Screen name="language" />
            <Stack.Screen name="owner" />
            <Stack.Screen
              name="driver"
              options={{
                presentation: 'fullScreenModal',
                animation: 'slide_from_bottom',
              }}
            />
          </Stack>
        </DriverContext.Provider>
      </CarrierOwnerContext.Provider>
    </AppModeContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reusable UI primitives for gate / error screens
// ─────────────────────────────────────────────────────────────────────

function GateErrorScreen({
  icon,
  title,
  subtext,
  onRetry,
  onSignOut,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtext: string;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <View style={styles.loading}>
      <Ionicons name={icon} size={48} color={colors.warning} />
      <Text style={styles.loadingTitle}>{title}</Text>
      <Text style={styles.loadingSubtext}>{subtext}</Text>
      <Pressable style={styles.retryButton} onPress={onRetry}>
        <Ionicons name="refresh" size={18} color={colors.primaryForeground} />
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
      <Pressable style={styles.signOutLink} onPress={onSignOut}>
        <Text style={styles.signOutLinkText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

function NotRegisteredScreen({
  title = 'Not Registered',
  message,
  onSignOut,
}: {
  title?: string;
  message: string;
  onSignOut: () => void;
}) {
  return (
    <View style={styles.error}>
      <Ionicons name="warning" size={64} color={colors.warning} />
      <Text style={styles.errorTitle}>{title}</Text>
      <Text style={styles.errorText}>{message}</Text>
      <Pressable
        style={styles.errorButton}
        onPress={onSignOut}
      >
        <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
        <Text style={styles.errorButtonText}>Back to Sign In</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  loadingText: {
    color: colors.foregroundMuted,
    marginTop: 16,
    fontSize: typography.base,
  },
  loadingTitle: {
    fontSize: typography.lg,
    fontWeight: typography.semibold as '600',
    color: colors.foreground,
    marginTop: 16,
    marginBottom: 8,
  },
  loadingSubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center' as const,
    lineHeight: 20,
    paddingHorizontal: 32,
    marginBottom: 20,
  },
  retryButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    gap: 8,
    marginBottom: 12,
  },
  retryButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.base,
    fontWeight: typography.semibold as '600',
  },
  signOutLink: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  signOutLinkText: {
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    textDecorationLine: 'underline' as const,
  },
  error: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
    padding: 24,
  },
  errorTitle: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
    marginTop: 24,
    marginBottom: 12,
  },
  errorText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 24,
  },
  errorSubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 12,
    paddingHorizontal: 16,
  },
  errorButton: {
    marginTop: 24,
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.base,
    fontWeight: typography.semibold,
  },
  // Switch Mode Button (for switching between driver/owner)
  switchModeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 12,
    backgroundColor: colors.muted,
    borderRadius: borderRadius.full,
    gap: 4,
  },
  switchModeText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
  },
  // Role Selection Styles
  roleSelectionContainer: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
    paddingTop: 80,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary + '15',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    marginBottom: 24,
    gap: 8,
  },
  verifiedText: {
    color: colors.primary,
    fontSize: typography.sm,
    fontWeight: typography.medium,
  },
  welcomeTitle: {
    fontSize: typography['3xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
    marginBottom: 12,
  },
  welcomeSubtitle: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    lineHeight: 22,
    marginBottom: 32,
  },
  roleOptionsContainer: {
    gap: 16,
    marginBottom: 32,
  },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 16,
  },
  roleIconBox: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  roleCardContent: {
    flex: 1,
  },
  roleTitle: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    color: colors.foreground,
    marginBottom: 4,
  },
  roleDescription: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    lineHeight: 18,
  },
  activeAccountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 32,
  },
  accountAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: typography.lg,
    fontWeight: typography.bold,
    color: colors.primaryForeground,
  },
  accountInfo: {
    flex: 1,
  },
  accountLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    letterSpacing: 1,
    marginBottom: 2,
  },
  accountName: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  switchButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: borderRadius.md,
  },
  switchButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.sm,
    fontWeight: typography.semibold,
  },
  helpText: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  helpLink: {
    color: colors.foreground,
    fontWeight: typography.semibold,
  },
});
