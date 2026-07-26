/**
 * DispatchMovedScreen — split-plan §6 driver cleanup, release N.
 *
 * Rendered by the (app) layout in place of the owner tree when the
 * `owner_mode_in_driver_app` flag is off: owner tools have moved to the
 * Otoqa Dispatch app. Driver mode is untouched — dual-role users get a
 * "Continue as driver" escape hatch; owner-only users can sign out.
 *
 * "Open Otoqa Dispatch" tries the app's scheme first (installed → opens),
 * then falls back to the store listing. No canOpenURL — that would need
 * LSApplicationQueriesSchemes / Android package-visibility entries; a
 * plain openURL attempt rejects when unhandled and we catch it.
 */
import { Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, borderRadius } from './theme';
import { trackDispatchMigration } from './analytics';

const DISPATCH_SCHEME_URL = 'otoqa-dispatch://';
const DISPATCH_ANDROID_MARKET_URL = 'market://details?id=com.otoqa.dispatch';
const DISPATCH_ANDROID_WEB_URL =
  'https://play.google.com/store/apps/details?id=com.otoqa.dispatch';
// TODO(release N ship-blocker): set the numeric App Store URL once the
// Otoqa Dispatch listing exists, e.g. 'https://apps.apple.com/app/id123456789'.
const DISPATCH_IOS_STORE_URL: string | null = null;

async function openDispatchApp(): Promise<void> {
  trackDispatchMigration('open_dispatch');
  const attempts: string[] = [DISPATCH_SCHEME_URL];
  if (Platform.OS === 'android') {
    attempts.push(DISPATCH_ANDROID_MARKET_URL, DISPATCH_ANDROID_WEB_URL);
  } else if (DISPATCH_IOS_STORE_URL) {
    attempts.push(DISPATCH_IOS_STORE_URL);
  }
  for (const url of attempts) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // Not installed / no handler — try the next fallback.
    }
  }
  Alert.alert(
    'Install Otoqa Dispatch',
    `Search for “Otoqa Dispatch” in the ${
      Platform.OS === 'ios' ? 'App Store' : 'Play Store'
    } to install it, then sign in with this same phone number.`,
  );
}

export function DispatchMovedScreen({
  canContinueAsDriver,
  onContinueAsDriver,
  onSignOut,
}: {
  canContinueAsDriver: boolean;
  onContinueAsDriver: () => void;
  onSignOut: () => void;
}) {
  useEffect(() => {
    trackDispatchMigration('interstitial_shown');
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.iconBox}>
        <Ionicons name="swap-horizontal" size={40} color={colors.primary} />
      </View>
      <Text style={styles.title}>Owner tools have moved</Text>
      <Text style={styles.body}>
        Dispatching, fleet, and settlement tools now live in Otoqa Dispatch — our new app for
        owners and dispatchers. Install it and sign in with the same phone number you use here.
      </Text>
      <Pressable style={styles.primaryButton} onPress={() => void openDispatchApp()}>
        <Ionicons name="open-outline" size={18} color={colors.primaryForeground} />
        <Text style={styles.primaryButtonText}>Open Otoqa Dispatch</Text>
      </Pressable>
      {canContinueAsDriver ? (
        <Pressable
          style={styles.secondaryLink}
          onPress={() => {
            trackDispatchMigration('continue_as_driver');
            onContinueAsDriver();
          }}
        >
          <Text style={styles.secondaryLinkText}>Continue as driver</Text>
        </Pressable>
      ) : (
        <Pressable
          style={styles.secondaryLink}
          onPress={() => {
            trackDispatchMigration('sign_out');
            onSignOut();
          }}
        >
          <Text style={styles.secondaryLinkText}>Sign out</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
    padding: 28,
  },
  iconBox: {
    width: 72,
    height: 72,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary + '15',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 28,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: borderRadius.md,
    gap: 8,
    marginBottom: 14,
  },
  primaryButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.base,
    fontWeight: typography.semibold,
  },
  secondaryLink: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryLinkText: {
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    textDecorationLine: 'underline',
  },
});
