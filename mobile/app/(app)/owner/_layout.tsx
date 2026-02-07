import { Tabs } from 'expo-router';
import { View, StyleSheet, Text } from 'react-native';
import { Ionicons, Feather } from '@expo/vector-icons';
import { colors, isIOS } from '../../../lib/theme';
import { useLanguage } from '../../../lib/LanguageContext';

// ============================================
// OWNER LAYOUT - Carrier Owner Navigation
// Dashboard, Drivers, Profile, More
// ============================================

// Android floating pill style
const androidTabBarStyle = {
  position: 'absolute' as const,
  bottom: 28,
  left: 0,
  right: 0,
  marginHorizontal: 24,
  backgroundColor: colors.card,
  borderRadius: 35,
  height: 70,
  paddingTop: 10,
  paddingBottom: 10,
  borderTopWidth: 0,
  borderWidth: 1,
  borderColor: 'rgba(63, 69, 82, 0.5)',
  elevation: 8,
};

// iOS style - dark background with floating pill illusion
const iosTabBarStyle = {
  backgroundColor: colors.background,
  borderTopColor: colors.background,
  height: 90,
  paddingTop: 4,
  paddingBottom: 26,
  paddingHorizontal: 40,
};

// Decorative floating pill for iOS (rendered behind the transparent tab bar)
function IOSTabBarBackground() {
  return (
    <View style={iosBackgroundStyles.container}>
      <View style={iosBackgroundStyles.pill} />
    </View>
  );
}

const iosBackgroundStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 90,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 0,
    backgroundColor: colors.background,
    borderTopWidth: 2,
    borderTopColor: colors.background,
  },
  pill: {
    backgroundColor: colors.card,
    borderRadius: 30,
    height: 60,
    marginHorizontal: 20,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
});

export default function OwnerLayout() {
  const { t } = useLanguage();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: isIOS ? iosTabBarStyle : androidTabBarStyle,
        tabBarBackground: isIOS ? () => <IOSTabBarBackground /> : undefined,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.foregroundMuted,
        tabBarItemStyle: {
          height: 50,
          justifyContent: 'center',
          alignItems: 'center',
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerShown: false,
          tabBarLabel: ({ focused }) => (
            <Text maxFontSizeMultiplier={1.2} style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
              {t('nav.home')}
            </Text>
          ),
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabIconContainer}>
              <Ionicons
                name={focused ? 'home' : 'home-outline'}
                size={28}
                color={focused ? colors.primary : colors.foregroundMuted}
              />
            </View>
          ),
        }}
      />
      {/* Hidden screens */}
      <Tabs.Screen name="loads" options={{ href: null, headerShown: false, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="assign-driver" options={{ href: null, headerShown: false, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="complete-driver-profile" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="feature-unavailable" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="notifications" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="tracking" options={{ href: null, tabBarStyle: { display: 'none' } }} />
      <Tabs.Screen name="settlements" options={{ href: null }} />

      <Tabs.Screen
        name="drivers"
        options={{
          headerShown: false,
          tabBarLabel: ({ focused }) => (
            <Text maxFontSizeMultiplier={1.2} style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
              {t('nav.drivers')}
            </Text>
          ),
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabIconContainer}>
              <Ionicons
                name={focused ? 'people' : 'people-outline'}
                size={28}
                color={focused ? colors.primary : colors.foregroundMuted}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          headerShown: false,
          tabBarLabel: ({ focused }) => (
            <Text maxFontSizeMultiplier={1.2} style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
              {t('nav.profile')}
            </Text>
          ),
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabIconContainer}>
              <Ionicons
                name={focused ? 'person' : 'person-outline'}
                size={28}
                color={focused ? colors.primary : colors.foregroundMuted}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          headerShown: false,
          tabBarLabel: ({ focused }) => (
            <Text maxFontSizeMultiplier={1.2} style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
              {t('nav.more')}
            </Text>
          ),
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabIconContainer}>
              <Feather
                name="more-horizontal"
                size={28}
                color={focused ? colors.primary : colors.foregroundMuted}
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
  tabLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.foregroundMuted,
  },
  tabLabelFocused: {
    color: colors.primary,
  },
});
