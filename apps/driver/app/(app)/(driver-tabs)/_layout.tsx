/**
 * Driver bottom tabs — Otoqa Driver design system.
 *
 * Uses the stock `Tabs` bar from expo-router (react-navigation's bottom-tabs
 * under the hood) and customizes the visuals via `screenOptions`. Three
 * earlier attempts went custom on the tabBar — navigation.navigate,
 * router.push, and CommonActions.dispatch — and all silently no-op'd
 * under expo-router v6. The stock bar handles press + dispatch itself,
 * so we only supply icons / labels / styles.
 */
import React from 'react';
import { Tabs } from 'expo-router';
import { View, StyleSheet, Text, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../../lib/LanguageContext';
import { useTheme } from '../../../lib/ThemeContext';
import { Icon, type IconName } from '../../../lib/design-icons';
import { type Palette } from '../../../lib/design-tokens';

const TabIcon: React.FC<{
  name: IconName;
  focused: boolean;
  palette: Palette;
}> = ({ name, focused, palette }) => (
  <View
    style={[
      styles.iconWrap,
      focused && { backgroundColor: palette.accentTint },
    ]}
  >
    <Icon
      name={name}
      size={22}
      color={focused ? palette.accent : palette.textTertiary}
      strokeWidth={focused ? 2.2 : 1.5}
    />
  </View>
);

const TabLabel: React.FC<{ label: string; focused: boolean; palette: Palette }> = ({
  label,
  focused,
  palette,
}) => (
  <Text
    maxFontSizeMultiplier={1.2}
    style={[
      styles.label,
      { color: focused ? palette.accent : palette.textTertiary },
    ]}
  >
    {label}
  </Text>
);

export default function DriverTabs() {
  const { palette } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Layout math
  // ─────────────────────────────────────────────────────────
  // React-navigation's BottomTabItem uses `justifyContent: flex-start`
  // on its column, so icon+label sit at the TOP of each item — *not*
  // centered. With the previous 50pt content band the label's
  // baseline landed below the item's centerline, which made the glyphs
  // feel pinned to the top-edge of the bar (the background grew from
  // our #55 inset fix, but the icons visually didn't move).
  //
  // Fix: enlarge the content band to 64pt so icon (28) + label (~16)
  // + item's own 5pt padding breathe naturally, and explicitly center
  // the item's column so icons + labels are vertically centered inside
  // the band.
  const bottomInset = Platform.OS === 'ios' ? 24 : Math.max(insets.bottom, 10);
  const CONTENT_BAND = 64;
  const TOP_PAD = 8;
  const tabHeight = TOP_PAD + CONTENT_BAND + bottomInset;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.bgSurface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: palette.borderSubtle,
          height: tabHeight,
          paddingTop: TOP_PAD,
          paddingBottom: bottomInset,
          elevation: 0,
        },
        tabBarItemStyle: {
          // Override the stock `justifyContent: flex-start` so icon +
          // label sit centered in the content band, not pinned to the
          // item top.
          justifyContent: 'center',
          paddingVertical: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="home" focused={focused} palette={palette} />
          ),
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.home')} focused={focused} palette={palette} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="message" focused={focused} palette={palette} />
          ),
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.messages')} focused={focused} palette={palette} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="user" focused={focused} palette={palette} />
          ),
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.profile')} focused={focused} palette={palette} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="more-h" focused={focused} palette={palette} />
          ),
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.more')} focused={focused} palette={palette} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
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
    marginTop: 2,
  },
});
