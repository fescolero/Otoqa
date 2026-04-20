/**
 * Driver bottom tabs — Otoqa Driver design system.
 *
 * Flat bar with 4 tabs: Home, Messages, Profile, More. Icons are HugeIcons
 * via the design-system `Icon` wrapper, palette comes from ThemeContext so
 * the bar follows the user's light/dark/system preference.
 */
import React, { useMemo } from 'react';
import { Tabs } from 'expo-router';
import { View, StyleSheet, Text, Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useLanguage } from '../../../lib/LanguageContext';
import { useTheme } from '../../../lib/ThemeContext';
import { Icon, type IconName } from '../../../lib/design-icons';
import { radii, type Palette } from '../../../lib/design-tokens';

type TabKey = 'index' | 'messages' | 'settings' | 'more';

type TabSpec = {
  name: TabKey;
  icon: IconName;
  labelKey: 'nav.home' | 'nav.messages' | 'nav.profile' | 'nav.more';
};

// Free HugeIcons ships outlined-only — no filled variants for home/user/
// message/more. Active state is expressed via a tinted pill + thicker stroke
// + accent color instead of swapping to a solid glyph.
const TAB_SPECS: readonly TabSpec[] = [
  { name: 'index', icon: 'home', labelKey: 'nav.home' },
  { name: 'messages', icon: 'message', labelKey: 'nav.messages' },
  { name: 'settings', icon: 'user', labelKey: 'nav.profile' },
  { name: 'more', icon: 'more-h', labelKey: 'nav.more' },
];

function DriverTabBar({ state, navigation }: BottomTabBarProps) {
  const { palette } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: Math.max(insets.bottom, 12) },
      ]}
    >
      {state.routes.map((route, index) => {
        const spec = TAB_SPECS.find((s) => s.name === route.name);
        if (!spec) return null;

        const isActive = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isActive && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const color = isActive ? palette.accent : palette.textTertiary;

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isActive ? { selected: true } : {}}
            accessibilityLabel={t(spec.labelKey)}
            onPress={onPress}
            style={({ pressed }) => [
              styles.tab,
              pressed && { opacity: 0.7 },
            ]}
          >
            <View
              style={[
                styles.iconWrap,
                isActive && { backgroundColor: palette.accentTint },
              ]}
            >
              <Icon
                name={spec.icon}
                size={22}
                color={color}
                strokeWidth={isActive ? 2.2 : 1.5}
              />
            </View>
            <Text
              maxFontSizeMultiplier={1.2}
              style={[styles.label, { color }]}
            >
              {t(spec.labelKey)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function DriverTabs() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <DriverTabBar {...props} />}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="messages" />
      <Tabs.Screen name="settings" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      paddingTop: 8,
      paddingHorizontal: 8,
      backgroundColor: palette.bgSurface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.borderSubtle,
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -1 },
          shadowOpacity: 0.04,
          shadowRadius: 3,
        },
        android: { elevation: 0 },
      }),
    },
    tab: {
      flex: 1,
      paddingVertical: 4,
      paddingHorizontal: 4,
      borderRadius: radii.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    iconWrap: {
      width: 40,
      height: 28,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      fontSize: 11,
      fontWeight: '500',
      letterSpacing: 0.3,
    },
  });
