/**
 * UpdateGate — Convex-driven native-build update prompt.
 *
 * OTA bundles apply themselves (lib/auto-update.ts); a new NATIVE build
 * needs the driver to install an APK/TestFlight build, and nothing in the
 * app told them to. This component closes that gap from a single mount
 * point in the root layout, over both the sign-in and signed-in stacks:
 *
 *   • build < minSupportedBuild → full-screen block. The build is too old
 *     to trust (schema drift, dead native modules) — the only way forward
 *     is the install link.
 *   • build < latestBuild → top banner, dismissible for the rest of the
 *     app session. Reappears on next cold start until the driver updates.
 *
 * The config is a live Convex subscription, so flipping the row (via
 * `npx convex run driverAppConfig:setConfig ...`) pushes the banner to
 * every online phone immediately — no store, no push, no redeploy.
 *
 * Renders nothing while the config is loading, missing, or when the build
 * number is unknown (dev client / Expo Go) — the gate must never block a
 * phone on bad data.
 */
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Application from 'expo-application';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { useTheme } from '../lib/ThemeContext';
import { trackUpdateGate } from '../lib/analytics';

export function UpdateGate() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const shownTracked = useRef<'banner' | 'blocked' | null>(null);

  const config = useQuery(api.driverAppConfig.get, {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  });

  const build = Number(Application.nativeBuildVersion ?? NaN);
  const blocked = config != null && Number.isFinite(build) && build < config.minSupportedBuild;
  const behind = config != null && Number.isFinite(build) && build < config.latestBuild;

  useEffect(() => {
    if (!config) return;
    const state = blocked ? 'blocked' : behind ? 'banner' : null;
    if (!state || shownTracked.current === state) return;
    shownTracked.current = state;
    trackUpdateGate(state === 'blocked' ? 'blocked_shown' : 'banner_shown', {
      latestBuild: config.latestBuild,
      minSupportedBuild: config.minSupportedBuild,
    });
  }, [config, blocked, behind]);

  if (!config || !behind) return null;

  const openInstall = (kind: 'banner_tapped' | 'blocked_tapped') => {
    trackUpdateGate(kind, {
      latestBuild: config.latestBuild,
      minSupportedBuild: config.minSupportedBuild,
    });
    Linking.openURL(config.installUrl).catch(() => {});
  };

  if (blocked) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.blockRoot, { backgroundColor: palette.bgCanvas }]}>
        <View style={[styles.blockCard, { backgroundColor: palette.bgSurfaceElevated, borderColor: palette.borderSubtle }]}>
          <Text style={[styles.blockTitle, { color: palette.textPrimary }]}>Update required</Text>
          <Text style={[styles.blockBody, { color: palette.textSecondary }]}>
            {config.message ??
              'This version of Otoqa Driver is no longer supported. Install the latest version to keep tracking your shifts.'}
          </Text>
          <Pressable
            onPress={() => openInstall('blocked_tapped')}
            style={({ pressed }) => [
              styles.blockButton,
              { backgroundColor: pressed ? palette.accentPressed : palette.accent },
            ]}
          >
            <Text style={[styles.blockButtonText, { color: palette.textOnAction }]}>Download update</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (dismissed) return null;

  return (
    <View pointerEvents="box-none" style={[styles.bannerRoot, { top: insets.top + 8 }]}>
      <View
        style={[
          styles.banner,
          { backgroundColor: palette.bgSurfaceElevated, borderColor: palette.borderDefault },
        ]}
      >
        <View style={styles.bannerTextWrap}>
          <Text style={[styles.bannerTitle, { color: palette.textPrimary }]}>New version available</Text>
          <Text style={[styles.bannerBody, { color: palette.textSecondary }]} numberOfLines={2}>
            {config.message ?? 'Install the latest Otoqa Driver update when you get a moment.'}
          </Text>
        </View>
        <Pressable
          onPress={() => openInstall('banner_tapped')}
          style={({ pressed }) => [
            styles.bannerButton,
            { backgroundColor: pressed ? palette.accentPressed : palette.accent },
          ]}
        >
          <Text style={[styles.bannerButtonText, { color: palette.textOnAction }]}>Update</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            trackUpdateGate('banner_dismissed', {
              latestBuild: config.latestBuild,
              minSupportedBuild: config.minSupportedBuild,
            });
            setDismissed(true);
          }}
          hitSlop={10}
          style={styles.bannerClose}
        >
          <Text style={[styles.bannerCloseText, { color: palette.textTertiary }]}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  blockRoot: {
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  blockCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    gap: 12,
  },
  blockTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  blockBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  blockButton: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  blockButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  bannerRoot: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 999,
    elevation: 999,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 8,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  bannerTextWrap: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  bannerBody: {
    fontSize: 12,
    marginTop: 1,
  },
  bannerButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  bannerButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  bannerClose: {
    paddingHorizontal: 6,
  },
  bannerCloseText: {
    fontSize: 14,
  },
});
