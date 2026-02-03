import { Redirect, Tabs, Stack, Slot, useRouter } from 'expo-router';
import { useAuth, useUser } from '@clerk/clerk-expo';
import {
  View,
  ActivityIndicator,
  StyleSheet,
  Text,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Id } from '../../../convex/_generated/dataModel';
import { useConvexAuthState } from '../../lib/convex';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, typography, borderRadius, shadows } from '../../lib/theme';
import { resumeTracking } from '../../lib/location-tracking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CompleteDriverProfileScreen from './owner/complete-driver-profile';
import { useLanguage } from '../../lib/LanguageContext';

const MODE_STORAGE_KEY = '@app_mode_selection';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NAV_HORIZONTAL_MARGIN = 24;

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

// Driver mode tabs navigation
function DriverTabs({
  profile,
}: {
  profile: { _id: Id<'drivers'>; firstName: string; lastName: string; organizationId: string; truck?: TruckInfo };
}) {
  const [activeTab, setActiveTab] = useState('index');
  const { t } = useLanguage();

  return (
    <DriverContext.Provider
      value={{
        driverId: profile._id,
        driverName: `${profile.firstName} ${profile.lastName}`,
        organizationId: profile.organizationId,
        truck: profile.truck ?? null,
        isLoading: false,
      }}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            bottom: 28,
            left: 0,
            right: 0,
            marginHorizontal: NAV_HORIZONTAL_MARGIN,
            backgroundColor: colors.card,
            borderRadius: 35,
            height: 70,
            paddingTop: 10,
            paddingBottom: 10,
            borderTopWidth: 0,
            borderWidth: 1,
            borderColor: 'rgba(63, 69, 82, 0.5)',
            ...shadows.lg,
          },
          tabBarItemStyle: {
            height: 50,
            justifyContent: 'center',
            alignItems: 'center',
          },
          tabBarActiveTintColor: colors.foreground,
          tabBarInactiveTintColor: colors.foregroundMuted,
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '500',
            marginTop: 2,
          },
          tabBarIconStyle: {
            marginBottom: 0,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            tabBarLabel: t('nav.home'),
            tabBarIcon: ({ focused }) => (
              <View style={styles.tabIconContainer}>
                <Ionicons
                  name={focused ? 'home' : 'home-outline'}
                  size={22}
                  color={focused ? colors.foreground : colors.foregroundMuted}
                />
              </View>
            ),
          }}
          listeners={{
            tabPress: () => setActiveTab('index'),
          }}
        />
        <Tabs.Screen
          name="messages"
          options={{
            tabBarLabel: t('nav.messages'),
            tabBarIcon: ({ focused }) => (
              <View style={styles.tabIconContainer}>
                <Ionicons
                  name={focused ? 'chatbubble' : 'chatbubble-outline'}
                  size={22}
                  color={focused ? colors.foreground : colors.foregroundMuted}
                />
              </View>
            ),
          }}
          listeners={{
            tabPress: () => setActiveTab('messages'),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            tabBarLabel: t('nav.profile'),
            tabBarIcon: ({ focused }) => (
              <View style={styles.tabIconContainer}>
                <Ionicons
                  name={focused ? 'person' : 'person-outline'}
                  size={22}
                  color={focused ? colors.foreground : colors.foregroundMuted}
                />
              </View>
            ),
          }}
          listeners={{
            tabPress: () => setActiveTab('settings'),
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            tabBarLabel: t('nav.more'),
            tabBarIcon: ({ focused }) => (
              <View style={styles.tabIconContainer}>
                <Feather
                  name="more-horizontal"
                  size={22}
                  color={focused ? colors.foreground : colors.foregroundMuted}
                />
              </View>
            ),
          }}
          listeners={{
            tabPress: () => setActiveTab('more'),
          }}
        />
        {/* Hide non-tab screens */}
        <Tabs.Screen
          name="trip/[id]"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="capture-photo"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="switch-truck"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="permissions"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="notifications"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="language"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="driver"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        {/* Hide owner screens from driver tabs */}
        <Tabs.Screen name="owner" options={{ href: null }} />
      </Tabs>
    </DriverContext.Provider>
  );
}


export default function AppLayout() {
  const { isSignedIn, isLoaded: clerkLoaded, userId, signOut } = useAuth();
  const { user } = useUser();
  const convexAuth = useConvexAuthState();
  const hasResumedRef = useRef(false);
  const [mode, setModeState] = useState<'driver' | 'owner'>('driver');
  const [hasSelectedRole, setHasSelectedRole] = useState(false);
  const [isLoadingStoredMode, setIsLoadingStoredMode] = useState(true);

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
    const loadStoredMode = async () => {
      try {
        // We still load the stored mode preference for mid-session switching,
        // but we don't restore hasSelectedRole - carrier must always choose on sign-in
        const stored = await AsyncStorage.getItem(MODE_STORAGE_KEY);
        if (stored) {
          const { mode: storedMode } = JSON.parse(stored);
          if (storedMode) {
            // Store the preference but don't mark as selected
            // This allows the mode to be remembered for switching during the session
            setModeState(storedMode);
          }
        }
      } catch (e) {
        console.warn('Failed to load mode from storage:', e);
      } finally {
        setIsLoadingStoredMode(false);
      }
    };
    loadStoredMode();
  }, []);

  // Get user's organization ID from Clerk (for legacy support)
  const clerkOrgId = user?.organizationMemberships?.[0]?.organization?.id;

  // Query user roles to determine if driver, owner, or both
  // This now also returns carrier org info directly
  const userRoles = useQuery(
    api.carrierMobile.getUserRoles,
    convexAuth.isAuthenticated && userId
      ? { clerkUserId: userId, clerkOrgId: clerkOrgId }
      : 'skip'
  );

  // Query driver profile if user can be a driver (needed for mode switching)
  const profile = useQuery(
    api.driverMobile.getMyProfile,
    convexAuth.isAuthenticated && hasSelectedRole && (userRoles?.isDriver || mode === 'driver') ? {} : 'skip'
  );

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

  // Determine which modes are available
  const canBeDriver = userRoles?.isDriver ?? false;
  const canBeOwner = userRoles?.isCarrierOwner ?? false;
  const canSwitchModes = canBeDriver && canBeOwner;

  // Auto-select role ONLY if user has just one role
  useEffect(() => {
    if (userRoles && !isRolesLoading && !hasSelectedRole) {
      // If user is ONLY a driver (no carrier role), auto-select driver
      if (userRoles.isDriver && !userRoles.isCarrierOwner) {
        setMode('driver');
        setHasSelectedRole(true);
      }
      // If user has carrier role (either only carrier or both), show role selection
      // Don't auto-select - let them choose
    }
  }, [userRoles, isRolesLoading, hasSelectedRole]);

  // Handle role selection
  const handleSelectRole = async (selectedRole: 'driver' | 'owner') => {
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
    await signOut();
  };

  // Get router for navigation - only needed for owner mode
  const router = useRouter();
  const lastNavigatedModeRef = useRef<'driver' | 'owner' | null>(null);

  // Only navigate when entering owner mode
  // Driver mode doesn't need navigation - the layout just re-renders with DriverTabs
  useEffect(() => {
    if (!hasSelectedRole) return;
    
    // Only navigate TO owner mode (and only if we haven't already)
    if (mode === 'owner' && carrierOrg?._id && lastNavigatedModeRef.current !== 'owner') {
      lastNavigatedModeRef.current = 'owner';
      router.navigate('/(app)/owner');
    } else if (mode === 'driver') {
      // Just update the ref - no navigation needed
      // The layout will re-render and display DriverTabs
      lastNavigatedModeRef.current = 'driver';
    }
  }, [mode, hasSelectedRole, carrierOrg?._id]);

  // Resume location tracking on app start if it was active
  useEffect(() => {
    if (!hasResumedRef.current && profile?._id) {
      hasResumedRef.current = true;
      resumeTracking().then((result) => {
        if (result.resumed) {
          console.log('[App] Location tracking resumed:', result.message);
        }
      });
    }
  }, [profile?._id]);

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
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  // Wait for Convex auth setup
  if (convexAuth.isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Connecting to server...</Text>
      </View>
    );
  }

  // Show loading while fetching roles
  if (isRolesLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Checking permissions...</Text>
      </View>
    );
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
            <TouchableOpacity
              style={styles.roleCard}
              onPress={() => handleSelectRole('driver')}
              activeOpacity={0.7}
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
            </TouchableOpacity>
          )}

          {/* Dispatcher/Owner Option */}
          <TouchableOpacity
            style={styles.roleCard}
            onPress={() => handleSelectRole('owner')}
            activeOpacity={0.7}
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
          </TouchableOpacity>
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
          <TouchableOpacity 
            style={styles.switchButton}
            onPress={handleSignOut}
          >
            <Text style={styles.switchButtonText}>Switch</Text>
          </TouchableOpacity>
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
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading profile...</Text>
      </View>
    );
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
        <TouchableOpacity 
          style={styles.errorButton}
          onPress={handleSignOut}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.errorButtonText}>Back to Sign In</Text>
        </TouchableOpacity>
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
        <TouchableOpacity 
          style={styles.errorButton}
          onPress={handleSignOut}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.errorButtonText}>Back to Sign In</Text>
        </TouchableOpacity>
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
        <TouchableOpacity 
          style={styles.errorButton}
          onPress={handleSignOut}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.errorButtonText}>Back to Sign In</Text>
        </TouchableOpacity>
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
        <TouchableOpacity 
          style={styles.errorButton}
          onPress={handleSignOut}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.errorButtonText}>Back to Sign In</Text>
        </TouchableOpacity>
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
        {mode === 'driver' ? (
          profile ? (
            <DriverTabs profile={profile} />
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Loading driver profile...</Text>
            </View>
          )
        ) : mode === 'owner' && carrierOrg?._id ? (
          // Check if owner-operator needs to complete driver profile
          needsDriverProfileOnboarding ? (
            <CompleteDriverProfileScreen />
          ) : (
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="owner" />
              <Stack.Screen 
                name="driver" 
                options={{ 
                  presentation: 'fullScreenModal',
                  animation: 'slide_from_bottom',
                }} 
              />
            </Stack>
          )
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        )}
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
  tabIconContainer: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
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
