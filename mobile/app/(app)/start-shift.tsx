/**
 * Start Shift screen — the handshake between "I'm at the truck" and "I'm
 * on duty." Navigated to after a successful truck QR scan. Replaces the
 * in-line Alert.alert we were using in Phase 3 with a full-screen flow
 * that matches the Otoqa Driver design.
 *
 * Query params (passed via router.push):
 *   truckId: Id<'trucks'>
 *   truckUnitId: string (for display)
 *   truckMake?, truckModel?: string
 *
 * Actions:
 *   Start shift → startSession + startSessionTracking → navigate home
 *   Just pair  → go back, leave driver's currentTruckId set (switchTruck
 *                already ran) but don't open a session
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { useAppMode, useDriver } from './_layout';
import { startSessionTracking } from '../../lib/location-tracking';
import { usePostHog } from 'posthog-react-native';
import { Icon, type IconName } from '../../lib/design-icons';
import {
  typeScale,
  densitySpacing,
  radii,
  spacing,
  type Palette,
} from '../../lib/design-tokens';
import { useTheme } from '../../lib/ThemeContext';

const sp = densitySpacing.dense;

export default function StartShiftScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    truckId?: string;
    truckUnitId?: string;
    truckMake?: string;
    truckModel?: string;
  }>();

  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const { roles } = useAppMode();
  const driverId = roles?.driverId as Id<'drivers'> | undefined;
  // Driver organizationId comes from the profile context (DriverContext in
  // _layout.tsx), sourced from `profile.organizationId`. It's the same
  // value the rest of the driver tracking stack reads. The `roles` object
  // does NOT expose `organizationId` — a prior version of this screen
  // tried to read `roles.organizationId` via an `as unknown as` cast, and
  // since no such field exists on UserRoles at runtime, the guard that
  // followed ALWAYS fell through and startSessionTracking NEVER ran for
  // any driver in any shift. That bug left every driver in legacy_load
  // mode with pings carrying no sessionId, which silently broke Phase 1's
  // FCM wake path. Read from useDriver() — the source that's type-
  // checked and actually populated.
  const { organizationId: driverOrgId } = useDriver();

  const startSession = useMutation(api.driverSessions.startSession);
  const posthog = usePostHog();
  const [isStarting, setIsStarting] = useState(false);

  const truckIdStr = params.truckId ?? '';
  const truckUnitId = params.truckUnitId ?? '—';
  const truckMake = params.truckMake ?? '';
  const truckModel = params.truckModel ?? '';
  const truckTitle = [truckMake, truckModel].filter(Boolean).join(' ') || 'Truck';

  const handleStart = async () => {
    if (!driverId || !truckIdStr) {
      Alert.alert('Error', 'Missing driver or truck context.');
      return;
    }

    setIsStarting(true);
    try {
      const truckId = truckIdStr as Id<'trucks'>;
      const sessionId = await startSession({ driverId, truckId });
      posthog?.capture('shift_started', {
        sessionId,
        truckUnitId: params.truckUnitId ?? null,
      });

      // Session exists server-side. Now kick off GPS.
      //
      // driverOrgId is sourced from the profile context (above) which the
      // upstream profileGate guarantees is hydrated before this screen
      // renders. If somehow it's still null, fail LOUDLY — silently
      // skipping tracking was the pre-existing bug that left every
      // driver in legacy_load mode. The driver would see a "shift
      // started" toast but no GPS would actually flow.
      if (!driverOrgId) {
        posthog?.capture('start_shift_session_tracking_skipped', {
          reason: 'no_org_id',
          sessionId,
        });
        Alert.alert(
          'Tracking not started',
          'Your driver profile is still loading. Please wait a moment and tap Start Shift again.',
        );
        setIsStarting(false);
        return;
      }

      const result = await startSessionTracking({
        driverId,
        sessionId,
        organizationId: driverOrgId,
      });
      if (!result.success) {
        Alert.alert(
          'Shift started — GPS issue',
          `Shift is active but tracking didn't start: ${result.message}`,
          [{ text: 'OK', onPress: () => router.replace('/(driver-tabs)') }]
        );
        return;
      }
      router.replace('/(driver-tabs)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start shift';
      posthog?.capture('shift_start_failed', { error: msg });
      Alert.alert('Could not start shift', `${msg}\n\nTry again — if this keeps happening, contact dispatch.`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleSkip = () => {
    // Truck is already paired (switchTruck succeeded before we got here).
    // Just head back without opening a session.
    router.back();
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/(app)')
          }
          accessibilityLabel="Back"
          style={({ pressed }) => [
            styles.iconBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Icon name="arrow-left" size={22} color={palette.textPrimary} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Success mark */}
        <View style={styles.successRow}>
          <View style={styles.successMark}>
            <Icon name="check" size={22} color={palette.success} strokeWidth={2.5} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.successEyebrow}>TRUCK PAIRED</Text>
            <Text style={styles.successTitle}>Sharp and ready?</Text>
          </View>
        </View>

        {/* Truck card */}
        <View style={styles.truckCard}>
          <View style={styles.truckIcon}>
            <Icon name="truck" size={26} color={palette.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.truckTitle} numberOfLines={1}>
              Unit {truckUnitId}
              {truckTitle !== 'Truck' ? ` · ${truckTitle}` : ''}
            </Text>
            <Text style={styles.truckMeta} numberOfLines={1}>
              Paired and ready to roll
            </Text>
          </View>
        </View>

        {/* Pre-trip checklist */}
        <View style={styles.checklist}>
          <Text style={styles.sectionLabel}>BEFORE YOU DRIVE</Text>
          <View style={{ gap: 10, marginTop: 10 }}>
            <PretripRow
              icon="clipboard"
              label="Pre-trip inspection"
              meta="DVIR · walk around the truck"
            />
            <PretripRow
              icon="gauge"
              label="Fuel & fluids"
              meta="Check before leaving the yard"
            />
            <PretripRow
              icon="seat-belt"
              label="Buckle up"
              meta="Tracking begins once shift starts"
            />
          </View>
        </View>
      </ScrollView>

      {/* Sticky footer CTAs */}
      <View style={styles.footer}>
        <Pressable
          onPress={handleStart}
          disabled={isStarting}
          style={({ pressed }) => [
            styles.cta,
            pressed && { opacity: 0.9 },
            isStarting && { opacity: 0.7 },
          ]}
          accessibilityLabel="Start shift"
        >
          {isStarting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Icon name="play" size={16} color="#fff" />
              <Text style={styles.ctaText}>Start shift</Text>
            </>
          )}
        </Pressable>
        <Pressable
          onPress={handleSkip}
          disabled={isStarting}
          style={({ pressed }) => [
            styles.ctaSecondary,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.ctaSecondaryText}>Just pair, don't start yet</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const PretripRow: React.FC<{ icon: IconName; label: string; meta: string }> = ({
  icon,
  label,
  meta,
}) => {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <View style={styles.pretripRow}>
      <View style={styles.pretripIcon}>
        <Icon name={icon} size={16} color={palette.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.pretripLabel}>{label}</Text>
        <Text style={styles.pretripMeta}>{meta}</Text>
      </View>
    </View>
  );
};

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.bgCanvas,
  },
  topBar: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: sp.screenPx,
    paddingBottom: 120,
    gap: sp.sectionGap,
  },

  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: spacing.s2,
  },
  successMark: {
    width: 44,
    height: 44,
    borderRadius: 99,
    backgroundColor: 'rgba(16,185,129,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: palette.success,
  },
  successTitle: {
    ...typeScale.headingMd,
    color: palette.textPrimary,
    marginTop: 2,
  },

  truckCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: radii.lg,
    backgroundColor: palette.bgSurface,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
  },
  truckIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: palette.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  truckTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: palette.textPrimary,
  },
  truckMeta: {
    fontSize: 12,
    color: palette.textSecondary,
    marginTop: 2,
  },

  checklist: {
    padding: 14,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    backgroundColor: palette.bgSurface,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: palette.textTertiary,
  },
  pretripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pretripIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.md,
    backgroundColor: palette.bgMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pretripLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: palette.textPrimary,
  },
  pretripMeta: {
    fontSize: 11,
    color: palette.textTertiary,
    marginTop: 1,
  },

  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: sp.screenPx,
    paddingTop: 14,
    paddingBottom: 28,
    backgroundColor: palette.bgCanvas,
    gap: 10,
  },
  cta: {
    height: 52,
    borderRadius: radii.md,
    backgroundColor: palette.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  ctaText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  ctaSecondary: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaSecondaryText: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
});
