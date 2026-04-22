import { Redirect, Stack, useRouter } from 'expo-router';
import { useAuth, useUser } from '@clerk/clerk-expo';
import {
  View,
  StyleSheet,
  Text,
  Pressable,
  AppState,
} from 'react-native';
import { LoadingRingScreen } from '../../lib/otoqa-loader';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Id } from '../../../convex/_generated/dataModel';
import { useConvexAuthState } from '../../lib/convex';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, typography, borderRadius } from '../../lib/theme';
import { resumeTracking, getTrackingState, getBufferedLocationCount, forceFlush, restartForegroundServices } from '../../lib/location-tracking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CompleteDriverProfileScreen from './owner/complete-driver-profile';
import { useRequestPermissionsOnce } from '../../lib/request-permissions';
import { useRegisterPushToken } from '../../lib/hooks/useRegisterPushToken';
import {
  identifyUser,
  resetUser,
  trackRoleSelected,
  trackLoadingGateTimeout,
  trackLoadingGateResolved,
  trackLoadingGateRetry,
  trackAppSessionHealth,
  type LoadingGate,
} from '../../lib/analytics';

const MODE_STORAGE_KEY = '@app_mode_selection';
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
  isCarrierOwner: boolean;
  carrierOrgId: string | null;
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
  const { isSignedIn, isLoaded: clerkLoaded, userId, signOut } = useAuth();
  const { user } = useUser();
  const convexAuth = useConvexAuthState();
  const hasResumedRef = useRef(false);
  const [mode, setModeState] = useState<'driver' | 'owner'>('driver');
  const [hasSelectedRole, setHasSelectedRole] = useState(false);
  const [isLoadingStoredMode, setIsLoadingStoredMode] = useState(true);

  // Request all permissions (camera, location, notifications, etc.) once after sign-in
  useRequestPermissionsOnce();

  // Wrap setMode to persist to AsyncStorage
  const setMode = useCallback(async (newMode: 'driver' | 'owner') => {
    setModeState(newMode);
    try {
      await AsyncStorage.setItem(MODE_STORAGE_KEY, JSON.stringify({ mode: newMode, hasSelected: true }));
    } catch (e) {
      console.warn('Failed to save mode to storage:', e);
    }
  }, []);

  // Load persisted mode on mount - but DON'T auto-select role
  // Carriers should always see the role selection screen on sign-in
  useEffect(() => {
    let cancelled = false;
    const loadStoredMode = async () => {
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
    };
    loadStoredMode();
    return () => { cancelled = true; };
  }, []);

  // Get user's organization ID from Clerk (for legacy support)
  const clerkOrgId = user?.organizationMemberships?.[0]?.organization?.id;

  // Query user roles to determine if driver, owner, or both
  // This now also returns carrier org info directly
  const userRolesLive = useQuery(
    api.carrierMobile.getUserRoles,
    convexAuth.isAuthenticated && userId
      ? { clerkUserId: userId, clerkOrgId: clerkOrgId }
      : 'skip'
  );

  // Cache the last known roles so transient undefined states (token refresh,
  // reactive re-subscription) don't flash the "Checking permissions..." screen.
  const cachedRolesRef = useRef(userRolesLive);
  if (userRolesLive !== undefined) {
    cachedRolesRef.current = userRolesLive;
  }
  const userRoles = userRolesLive ?? cachedRolesRef.current;

  // Query driver profile if user can be a driver (needed for mode switching)
  // Pass driverId from getUserRoles so owner-operators can be found by direct lookup
  // instead of relying solely on phone number matching
  const profileLive = useQuery(
    api.driverMobile.getMyProfile,
    convexAuth.isAuthenticated && hasSelectedRole && (userRoles?.isDriver || mode === 'driver')
      ? { driverId: (userRoles?.driverId ?? undefined) as Id<'drivers'> | undefined }
      : 'skip'
  );

  // Cache last known profile to avoid flashing loading screen during re-subscriptions
  const cachedProfileRef = useRef(profileLive);
  if (profileLive !== undefined) {
    cachedProfileRef.current = profileLive;
  }
  const profile = profileLive ?? cachedProfileRef.current;

  // Carrier org info is now returned directly from userRoles
  // No need for separate query - use carrierOrgConvexId and carrierOrgName from userRoles
  const carrierOrg = userRoles?.isCarrierOwner ? {
    _id: userRoles.carrierOrgConvexId,
    name: userRoles.carrierOrgName || 'Carrier',
    clerkOrgId: userRoles.carrierOrgId,
    workosOrgId: userRoles.carrierOrgId,
    orgType: userRoles.orgType,
  } : null;

  // Check if owner-operator needs to complete driver profile
  const needsDriverProfileResult = useQuery(
    api.carrierMobile.needsDriverProfile,
    mode === 'owner' && userRoles?.isCarrierOwner && userRoles.isOwnerOperator && userRoles.carrierOrgConvexId
      ? { carrierOrgId: userRoles.carrierOrgConvexId }
      : 'skip'
  );
  
  const needsDriverProfileOnboarding = needsDriverProfileResult?.needsProfile === true;

  const isProfileLoading = mode === 'driver' && hasSelectedRole && userRoles?.isDriver && profile === undefined;
  const isCarrierOrgLoading = mode === 'owner' && hasSelectedRole && userRoles === undefined;
  const isRolesLoading = userRoles === undefined;

  // Loading gate monitors — track how long each gate takes and fire PostHog events on timeout
  const convexAuthGate = useLoadingGate('convex_auth', convexAuth.isLoading && !!isSignedIn);
  const rolesGate = useLoadingGate('user_roles', isRolesLoading && convexAuth.isAuthenticated);
  const profileGate = useLoadingGate('driver_profile', !!isProfileLoading);
  const carrierOrgGate = useLoadingGate('carrier_org', !!isCarrierOrgLoading);

  // Determine which modes are available
  const canBeDriver = userRoles?.isDriver ?? false;
  const canBeOwner = userRoles?.isCarrierOwner ?? false;
  const canSwitchModes = canBeDriver && canBeOwner;


  // Auto-select role ONLY if user has just one role
  useEffect(() => {
    if (userRoles && !isRolesLoading && !hasSelectedRole) {
      if (userRoles.isDriver && !userRoles.isCarrierOwner) {
        setMode('driver');
        setHasSelectedRole(true);
      }
    }
  }, [userRoles, isRolesLoading, hasSelectedRole]);

  // Identify user in PostHog once roles are known and mode is selected
  const hasIdentifiedRef = useRef(false);
  useEffect(() => {
    if (hasIdentifiedRef.current || !userId || !userRoles || !hasSelectedRole) return;
    hasIdentifiedRef.current = true;

    const role = userRoles.isDriver && userRoles.isCarrierOwner
      ? 'both'
      : userRoles.isDriver ? 'driver' : 'owner';

    identifyUser({
      id: userId,
      phone: user?.primaryPhoneNumber?.phoneNumber,
      name: user?.fullName ?? undefined,
      organizationId: userRoles.carrierOrgId ?? clerkOrgId ?? undefined,
      role,
    });
  }, [userId, userRoles, hasSelectedRole, user, clerkOrgId]);

  // Handle role selection
  const handleSelectRole = async (selectedRole: 'driver' | 'owner') => {
    trackRoleSelected(selectedRole);
    setHasSelectedRole(true);
    await setMode(selectedRole);
  };

  // Handle sign out - clear stored mode
  const handleSignOut = async () => {
    try {
      await AsyncStorage.removeItem(MODE_STORAGE_KEY);
    } catch (e) {
      console.warn('Failed to clear mode from storage:', e);
    }
    resetUser();
    await signOut();
  };

  // Get router for navigation - only needed for owner mode
  const router = useRouter();
  const lastNavigatedModeRef = useRef<'driver' | 'owner' | null>(null);

  // Navigate to the correct initial screen based on mode
  useEffect(() => {
    if (!hasSelectedRole) return;
    
    if (mode === 'owner' && carrierOrg?._id && lastNavigatedModeRef.current !== 'owner') {
      lastNavigatedModeRef.current = 'owner';
      router.navigate('/(app)/owner');
    } else if (mode === 'driver' && lastNavigatedModeRef.current !== 'driver') {
      lastNavigatedModeRef.current = 'driver';
      router.navigate('/(app)/(driver-tabs)');
    }
  }, [mode, hasSelectedRole, carrierOrg?._id]);

  // Resume location tracking on app start if it was active
  useEffect(() => {
    let cancelled = false;
    if (!hasResumedRef.current && profile?._id) {
      hasResumedRef.current = true;
      resumeTracking().then((result) => {
        if (!cancelled && result.resumed) {
          console.log('[App] Location tracking resumed:', result.message);
        }
      });
    }
    return () => { cancelled = true; };
  }, [profile?._id]);

  // When app returns to foreground:
  // 1. Restart foreground watch + sync interval (iOS suspends JS timers in background)
  // 2. Flush any buffered locations collected while backgrounded
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        try {
          // Restart foreground location watch and sync timer
          await restartForegroundServices();

          const state = await getTrackingState();
          if (!state?.isActive) return;
          const count = await getBufferedLocationCount();
          if (count > 0) {
            console.log(`[App] Foreground: ${count} buffered locations, flushing...`);
            const result = await forceFlush();
            console.log(`[App] Foreground flush result: synced=${result.synced}, success=${result.success}`);
          }
        } catch (err) {
          console.warn('[App] Foreground resume failed:', err);
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // Auto-switch modes when profile/org is not found
  useEffect(() => {
    // If in driver mode but no driver profile, switch to owner if possible
    if (mode === 'driver' && profile === null && canBeOwner) {
      console.log('Driver profile not found, switching to owner mode');
      setMode('owner');
    }
    // If in owner mode but no carrier org, switch to driver if possible  
    if (mode === 'owner' && (!carrierOrg || !carrierOrg._id) && canBeDriver && profile) {
      console.log('Carrier org not found, switching to driver mode');
      setMode('driver');
    }
  }, [mode, profile, carrierOrg, canBeOwner, canBeDriver]);

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
        <View style={styles.loading}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.warning} />
          <Text style={styles.loadingTitle}>Connection Slow</Text>
          <Text style={styles.loadingSubtext}>Having trouble connecting to the server.</Text>
          <Pressable style={styles.retryButton} onPress={() => { convexAuthGate.retry(); }}>
            <Ionicons name="refresh" size={18} color={colors.primaryForeground} />
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
          <Pressable style={styles.signOutLink} onPress={handleSignOut}>
            <Text style={styles.signOutLinkText}>Sign out</Text>
          </Pressable>
        </View>
      );
    }
    return <LoadingRingScreen statusText="Connecting to server…" subText="Hang tight" />;
  }

  // Show loading while fetching roles
  if (isRolesLoading) {
    if (rolesGate.isTimedOut) {
      return (
        <View style={styles.loading}>
          <Ionicons name="shield-outline" size={48} color={colors.warning} />
          <Text style={styles.loadingTitle}>Taking Longer Than Expected</Text>
          <Text style={styles.loadingSubtext}>Still checking your permissions. You can retry or sign out and try again.</Text>
          <Pressable style={styles.retryButton} onPress={() => { rolesGate.retry(); }}>
            <Ionicons name="refresh" size={18} color={colors.primaryForeground} />
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
          <Pressable style={styles.signOutLink} onPress={handleSignOut}>
            <Text style={styles.signOutLinkText}>Sign out</Text>
          </Pressable>
        </View>
      );
    }
    return <LoadingRingScreen statusText="Checking permissions…" subText="Hang tight" />;
  }

  // Show role selection if user has carrier access and hasn't selected yet
  if (!hasSelectedRole && canBeOwner) {
    const firstName = user?.firstName || userRoles?.carrierOrgName?.split(' ')[0] || 'there';
    
    return (
      <View style={styles.roleSelectionContainer}>
        {/* Header Badge */}
        <View style={styles.verifiedBadge}>
          <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
          <Text style={styles.verifiedText}>Carrier Identity Verified</Text>
        </View>

        {/* Welcome Message */}
        <Text style={styles.welcomeTitle}>Welcome back, {firstName}</Text>
        <Text style={styles.welcomeSubtitle}>
          Your account is associated with multiple carrier roles. Please select your workspace for today.
        </Text>

        {/* Role Options */}
        <View style={styles.roleOptionsContainer}>
          {/* Driver Option */}
          {canBeDriver && (
            <Pressable
              style={({ pressed }) => [styles.roleCard, pressed && { opacity: 0.7 }]}
              onPress={() => handleSelectRole('driver')}
            >
              <View style={[styles.roleIconBox, { backgroundColor: colors.primary + '20' }]}>
                <Ionicons name="person" size={24} color={colors.primary} />
              </View>
              <View style={styles.roleCardContent}>
                <Text style={styles.roleTitle}>Enter as Driver</Text>
                <Text style={styles.roleDescription}>
                  Access routes, update statuses, and manage your logs.
                </Text>
              </View>
              <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
            </Pressable>
          )}

          {/* Dispatcher/Owner Option */}
          <Pressable
            style={({ pressed }) => [styles.roleCard, pressed && { opacity: 0.7 }]}
            onPress={() => handleSelectRole('owner')}
          >
            <View style={[styles.roleIconBox, { backgroundColor: colors.warning + '20' }]}>
              <MaterialCommunityIcons name="monitor-dashboard" size={24} color={colors.warning} />
            </View>
            <View style={styles.roleCardContent}>
              <Text style={styles.roleTitle}>Enter as Dispatcher</Text>
              <Text style={styles.roleDescription}>
                Assign loads, monitor the fleet, and manage operations.
              </Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </Pressable>
        </View>

        {/* Active Account Display */}
        <View style={styles.activeAccountCard}>
          <View style={styles.accountAvatar}>
            <Text style={styles.avatarText}>
              {firstName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.accountInfo}>
            <Text style={styles.accountLabel}>ACTIVE ACCOUNT</Text>
            <Text style={styles.accountName}>
              {user?.fullName || userRoles?.carrierOrgName || 'User'}
            </Text>
          </View>
          <Pressable 
            style={styles.switchButton}
            onPress={handleSignOut}
          >
            <Text style={styles.switchButtonText}>Switch</Text>
          </Pressable>
        </View>

        {/* Help Link */}
        <Text style={styles.helpText}>
          Need help with your roles? Contact your administrator or our{' '}
          <Text style={styles.helpLink}>Support Team</Text>.
        </Text>
      </View>
    );
  }

  // Show loading while fetching profile/org
  if (isProfileLoading || isCarrierOrgLoading) {
    const activeGate = isProfileLoading ? profileGate : carrierOrgGate;
    if (activeGate.isTimedOut) {
      return (
        <View style={styles.loading}>
          <Ionicons name="person-outline" size={48} color={colors.warning} />
          <Text style={styles.loadingTitle}>Profile Load Slow</Text>
          <Text style={styles.loadingSubtext}>Having trouble loading your profile data.</Text>
          <Pressable style={styles.retryButton} onPress={() => { activeGate.retry(); }}>
            <Ionicons name="refresh" size={18} color={colors.primaryForeground} />
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
          <Pressable style={styles.signOutLink} onPress={handleSignOut}>
            <Text style={styles.signOutLinkText}>Sign out</Text>
          </Pressable>
        </View>
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
      <View style={styles.error}>
        <Ionicons name="warning" size={64} color={colors.warning} />
        <Text style={styles.errorTitle}>Not Registered</Text>
        <Text style={styles.errorText}>
          Your phone number is not registered as a driver or carrier owner in the system.
          Please contact your dispatcher or company administrator.
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

  // Handle driver mode when driver profile not found and can't switch
  if (mode === 'driver' && profile === null && !canBeOwner) {
    return (
      <View style={styles.error}>
        <Ionicons name="warning" size={64} color={colors.warning} />
        <Text style={styles.errorTitle}>Not Registered</Text>
        <Text style={styles.errorText}>
          Your phone number is not registered as a driver in the system.
          Please contact your dispatcher.
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

  // Handle owner mode when carrier org not found and can't switch
  if (mode === 'owner' && (!carrierOrg || !carrierOrg._id) && !canBeDriver) {
    return (
      <View style={styles.error}>
        <Ionicons name="warning" size={64} color={colors.warning} />
        <Text style={styles.errorTitle}>Organization Not Found</Text>
        <Text style={styles.errorText}>
          Your carrier organization is not set up yet.
          Please contact support to complete registration.
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


  // Register the Expo push token as soon as the driver is hydrated.
  // Runs once per mount-with-driver; the hook guards itself against
  // duplicate fires and silently skips on Expo Go.
  useRegisterPushToken(profile?._id ?? null);

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
