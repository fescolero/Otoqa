import { Tabs, Stack } from 'expo-router';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { colors, typography, borderRadius, shadows } from '../../../lib/theme';
import { useAppMode, useCarrierOwner } from '../_layout';
import { useLanguage } from '../../../lib/LanguageContext';

const NAV_HORIZONTAL_MARGIN = 24;

// ============================================
// OWNER LAYOUT - Carrier Owner Navigation
// Dashboard, Drivers, Profile, More
// ============================================

export default function OwnerLayout() {
  const { canSwitchModes, setMode } = useAppMode();
  const { orgName } = useCarrierOwner();
  const { t } = useLanguage();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerStyle: {
          backgroundColor: colors.background,
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        },
        headerTintColor: colors.foreground,
        headerTitleStyle: {
          fontWeight: '600',
          fontSize: typography.lg,
        },
        headerRight: () =>
          canSwitchModes ? (
            <TouchableOpacity
              onPress={() => setMode('driver')}
              style={styles.switchModeButton}
            >
              <Ionicons name="car" size={20} color={colors.primary} />
              <Text style={styles.switchModeText}>Driver</Text>
            </TouchableOpacity>
          ) : null,
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
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerShown: false,
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
      />
      {/* Loads page - full screen without nav */}
      <Tabs.Screen
        name="loads"
        options={{
          href: null,
          headerShown: false,
          tabBarStyle: { display: 'none' },
        }}
      />
      {/* Assign Driver page - hidden from tab bar */}
      <Tabs.Screen
        name="assign-driver"
        options={{
          href: null,
          headerShown: false,
          tabBarStyle: { display: 'none' },
        }}
      />
      {/* Complete Driver Profile - onboarding for owner-operators */}
      <Tabs.Screen
        name="complete-driver-profile"
        options={{
          href: null,
          headerShown: false,
          tabBarStyle: { display: 'none' },
        }}
      />
      {/* Feature Unavailable - full screen */}
      <Tabs.Screen
        name="feature-unavailable"
        options={{
          href: null,
          headerShown: false,
          tabBarStyle: { display: 'none' },
        }}
      />
      {/* Notifications - full screen */}
      <Tabs.Screen
        name="notifications"
        options={{
          href: null,
          headerShown: false,
          tabBarStyle: { display: 'none' },
        }}
      />
      <Tabs.Screen
        name="drivers"
        options={{
          headerShown: false,
          tabBarLabel: t('nav.drivers'),
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabIconContainer}>
              <Ionicons
                name={focused ? 'people' : 'people-outline'}
                size={22}
                color={focused ? colors.foreground : colors.foregroundMuted}
              />
            </View>
          ),
        }}
      />
      {/* Tracking tab hidden - moved to More page */}
      <Tabs.Screen
        name="tracking"
        options={{
          href: null,
        }}
      />
      {/* Settlements tab hidden - moved to More page */}
      <Tabs.Screen
        name="settlements"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          headerShown: false,
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
      />
      <Tabs.Screen
        name="more"
        options={{
          headerShown: false,
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
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabIconContainer: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
});
