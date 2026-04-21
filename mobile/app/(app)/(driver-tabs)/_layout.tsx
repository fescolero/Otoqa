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
  // Goal: icon + label sit in a 56pt "content band" with 8pt of
  // breathing room above it, above whatever bottom chrome the OS
  // shows (iOS home indicator ≈34, Android nav bar 0–48).
  //
  // We set `tabBarStyle.height = 8 + 56 + bottomInset` so the bar
  // grows with the inset, AND also push each item's content up by
  // the same inset via `tabBarItemStyle.paddingBottom`. Setting it
  // on the item (not the bar) is what actually moves the glyphs,
  // since react-navigation distributes item height evenly and
  // centers icons + labels inside each item's content area.
  const bottomInset =
    Platform.OS === 'ios' ? Math.max(insets.bottom, 20) : Math.max(insets.bottom, 12);
  const CONTENT_BAND = 56;
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
          // Nudge the label/icon pair up into the content band —
          // without this the item's default vertical centering leaves
          // the label hugging the very bottom of the content area.
          paddingBottom: 4,
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
