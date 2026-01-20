import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { View, ActivityIndicator, StyleSheet, Text, Dimensions } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Id } from '../../../convex/_generated/dataModel';
import { useConvexAuthState } from '../../lib/convex';
import { Ionicons, Feather } from '@expo/vector-icons';
import { colors, typography, borderRadius, shadows } from '../../lib/theme';
import { resumeTracking } from '../../lib/location-tracking';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NAV_HORIZONTAL_MARGIN = 24;

// ============================================
// APP LAYOUT - Dark Theme Floating Nav
// Professional Driver Dashboard Navigation
// ============================================

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

export default function AppLayout() {
  const { isSignedIn, isLoaded: clerkLoaded } = useAuth();
  const convexAuth = useConvexAuthState();
  const [activeTab, setActiveTab] = useState('index');
  const hasResumedRef = useRef(false);

  // Only query profile when Convex auth is ready
  const profile = useQuery(
    api.driverMobile.getMyProfile,
    convexAuth.isAuthenticated ? {} : 'skip'
  );
  const isProfileLoading = profile === undefined;

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

  // Wait for Clerk to be ready
  if (!clerkLoaded) {
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

  // Show loading while fetching profile
  if (isProfileLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading profile...</Text>
      </View>
    );
  }

  // Handle case where driver is not found
  if (profile === null) {
    return (
      <View style={styles.error}>
        <Ionicons name="warning" size={64} color={colors.warning} />
        <Text style={styles.errorTitle}>Not Registered</Text>
        <Text style={styles.errorText}>
          Your phone number is not registered as a driver in the system.
          Please contact your dispatcher.
        </Text>
      </View>
    );
  }

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
            tabBarLabel: 'Home',
            tabBarIcon: ({ focused }) => (
              <View style={focused ? styles.activeTabIcon : styles.tabIcon}>
                <Ionicons 
                  name={focused ? "home" : "home-outline"} 
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
            tabBarLabel: 'Messages',
            tabBarIcon: ({ focused }) => (
              <View style={focused ? styles.activeTabIconPill : styles.tabIcon}>
                <Ionicons 
                  name={focused ? "chatbubble" : "chatbubble-outline"} 
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
            tabBarLabel: 'Profile',
            tabBarIcon: ({ focused }) => (
              <View style={focused ? styles.activeTabIcon : styles.tabIcon}>
                <Ionicons 
                  name={focused ? "person" : "person-outline"} 
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
            tabBarLabel: 'More',
            tabBarIcon: ({ focused }) => (
              <View style={focused ? styles.activeTabIcon : styles.tabIcon}>
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
        {/* Hide trip detail from tabs and hide tab bar */}
        <Tabs.Screen
          name="trip/[id]"
          options={{
            href: null,
            tabBarStyle: { display: 'none' },
          }}
        />
        {/* Hide capture photo from tabs and hide tab bar */}
        <Tabs.Screen
          name="capture-photo"
          options={{
            href: null,
            tabBarStyle: { display: 'none' },
          }}
        />
        {/* Hide switch truck from tabs and hide tab bar */}
        <Tabs.Screen
          name="switch-truck"
          options={{
            href: null,
            tabBarStyle: { display: 'none' },
          }}
        />
        {/* Hide permissions from tabs and hide tab bar */}
        <Tabs.Screen
          name="permissions"
          options={{
            href: null,
            tabBarStyle: { display: 'none' },
          }}
        />
      </Tabs>
    </DriverContext.Provider>
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
  tabIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  activeTabIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  activeTabIconPill: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.muted,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
});
