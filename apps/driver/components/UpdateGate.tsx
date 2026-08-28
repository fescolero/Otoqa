/**
 * UpdateGate — Convex-driven native-build update prompt.
 *
 * OTA bundles apply themselves (lib/auto-update.ts); a new NATIVE build
 * needs the driver to install an APK/TestFlight build, and nothing in the
 * app told them to. This component closes that gap from a single mount
 * point in the root layout, over both the sign-in and signed-in stacks:
 *
 *   • build < minSupportedBuild → blocking bottom sheet over a dimmed app.
 *     The build is too old to trust (schema drift, dead native modules) —
 *     the only way forward is the install link. Three states, per design:
 *     live ("Update to X"), offline ("No connection" + Try again), and
 *     open-failed ("Couldn't open …" + Try again / Call dispatch).
 *   • build < latestBuild → top banner, dismissible for the rest of the
 *     app session. Reappears on next cold start until the driver updates.
 *
 * The config is a live Convex subscription, so flipping the row (via
 * `npx convex run driverAppConfig:setConfig ...`) pushes the sheet to
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
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { useTheme } from '../lib/ThemeContext';
import { useNetworkStatus } from '../lib/hooks/useNetworkStatus';
import { trackUpdateGate } from '../lib/analytics';

export function UpdateGate() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { isOffline } = useNetworkStatus();
  const [dismissed, setDismissed] = useState(false);
  // Sticky: once opening the install link fails we stay in the failed
  // state (Try again / Call dispatch) until a retry succeeds.
  const [openFailed, setOpenFailed] = useState(false);
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

  const newLabel = config.latestVersion ?? `build ${config.latestBuild}`;
  const currentLabel = Application.nativeApplicationVersion ?? `build ${build}`;

  const openInstall = async (kind: 'banner_tapped' | 'blocked_tapped') => {
    trackUpdateGate(kind, {
      latestBuild: config.latestBuild,
      minSupportedBuild: config.minSupportedBuild,
    });
    try {
      await Linking.openURL(config.installUrl);
      setOpenFailed(false);
    } catch {
      setOpenFailed(true);
    }
  };

  if (blocked) {
    const storeName = Platform.OS === 'ios' ? 'the App Store' : 'the download page';
    return (
      <View style={[StyleSheet.absoluteFill, styles.sheetRoot, { backgroundColor: palette.bgOverlay }]}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.bgSurfaceElevated,
              borderColor: palette.borderSubtle,
              paddingBottom: 20 + insets.bottom,
            },
          ]}
        >
          <View style={[styles.sheetIcon, { backgroundColor: palette.accentTint }]}>
            <Ionicons name="download-outline" size={26} color={palette.accent} />
          </View>
          <Text style={[styles.sheetTitle, { color: palette.textPrimary }]}>Update required</Text>
          <Text style={[styles.sheetBody, { color: palette.textSecondary }]}>
            {config.message ??
              'This version of Otoqa is no longer supported. Update to keep tracking loads and logging hours.'}
          </Text>

          <View style={[styles.versionChip, { backgroundColor: palette.bgSubtle }]}>
            <Text style={[styles.versionOld, { color: palette.textTertiary }]}>{currentLabel}</Text>
            <Ionicons name="arrow-forward" size={14} color={palette.textTertiary} />
            <Text style={[styles.versionNew, { color: palette.textPrimary }]}>{newLabel}</Text>
          </View>

          {isOffline ? (
            <View style={[styles.infoRow, { backgroundColor: palette.bgSubtle }]}>
              <Ionicons name="cloud-offline-outline" size={20} color={palette.textSecondary} />
              <View style={styles.infoRowTextWrap}>
                <Text style={[styles.infoRowTitle, { color: palette.textPrimary }]}>No connection</Text>
                <Text style={[styles.infoRowBody, { color: palette.textSecondary }]}>
                  Connect to Wi-Fi or cell data to download the update.
                </Text>
              </View>
            </View>
          ) : openFailed ? (
            <View style={[styles.errorRow, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: palette.danger }]}>
              <Ionicons name="warning-outline" size={18} color={palette.danger} />
              <View style={styles.infoRowTextWrap}>
                <Text style={[styles.infoRowTitle, { color: palette.danger }]}>
                  Couldn&apos;t open {storeName}
                </Text>
                <Text style={[styles.infoRowBody, { color: palette.textSecondary }]}>
                  {config.dispatchPhone
                    ? `Try again, or call dispatch at ${config.dispatchPhone}.`
                    : 'Try again in a moment.'}
                </Text>
              </View>
            </View>
          ) : null}

          <Pressable
            onPress={() => openInstall('blocked_tapped')}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: pressed ? palette.accentPressed : palette.accent },
            ]}
          >
            <Text style={[styles.primaryButtonText, { color: palette.textOnAction }]}>
              {isOffline || openFailed ? 'Try again' : `Update to ${newLabel}`}
            </Text>
          </Pressable>

          {openFailed && !isOffline && config.dispatchPhone ? (
            <Pressable
              onPress={() => Linking.openURL(`tel:${config.dispatchPhone}`).catch(() => {})}
              style={({ pressed }) => [
                styles.secondaryButton,
                {
                  borderColor: palette.borderDefault,
                  backgroundColor: pressed ? palette.bgSubtle : 'transparent',
                },
              ]}
            >
              <Ionicons name="call-outline" size={16} color={palette.textPrimary} />
              <Text style={[styles.secondaryButtonText, { color: palette.textPrimary }]}>Call dispatch</Text>
            </Pressable>
          ) : null}
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
            {config.message ?? `Install Otoqa Driver ${newLabel} when you get a moment.`}
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
          <Ionicons name="close" size={16} color={palette.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetRoot: {
    zIndex: 1000,
    elevation: 1000,
    justifyContent: 'flex-end',
    padding: 12,
  },
  sheet: {
    borderRadius: 24,
    borderWidth: 1,
    paddingTop: 28,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 12,
  },
  sheetIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  sheetBody: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  versionChip: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 4,
  },
  versionOld: {
    fontSize: 15,
    textDecorationLine: 'line-through',
  },
  versionNew: {
    fontSize: 15,
    fontWeight: '700',
  },
  infoRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 12,
    padding: 14,
  },
  errorRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  infoRowTextWrap: {
    flex: 1,
    gap: 2,
  },
  infoRowTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  infoRowBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  primaryButton: {
    alignSelf: 'stretch',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    fontSize: 15,
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
});
