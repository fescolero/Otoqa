/**
 * More tab — Otoqa Driver operational hub.
 *
 * Ports lib/more-screen.jsx from the design bundle. Shows shift status
 * (hero), current truck, and drill-in rows for App settings / Help /
 * About. Sign-out lives as the header kebab per design.
 *
 * Data sources (real, not mock):
 *   - Active session + elapsed time: useMyLoads(driverId).activeSession
 *   - Truck details: useDriver().truck
 *   - End shift: api.driverSessions.endSession
 *   - Sign out: useClerk().signOut
 *
 * Not ported yet (backend work pending):
 *   - HOS clock + Sync state strip (design shows "Drive remaining" /
 *     "Synced" tiles)
 *   - Dispatcher quick-call card
 *   - Shift summary stats (loads/miles/stops for the elapsed shift)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { trackScreen } from '../../../lib/analytics';
import { usePostHog } from 'posthog-react-native';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useClerk } from '@clerk/clerk-expo';
import { useMutation, useQuery } from 'convex/react';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { api } from '../../../../convex/_generated/api';
import { useDriver, useAppMode } from '../_layout';
import { stopSessionTracking } from '../../../lib/location-tracking';
import { Icon, type IconName } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

export default function MoreScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const { signOut } = useClerk();
  const posthog = usePostHog();
  const { driverId, truck } = useDriver();

  useEffect(() => {
    trackScreen('More');
  }, []);
  const { canSwitchModes, mode, setMode, roles } = useAppMode();
  const activeSession = useQuery(
    api.driverSessions.getActiveSession,
    driverId ? { driverId } : 'skip',
  );
  const endSessionMutation = useMutation(api.driverSessions.endSession);

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [endShiftOpen, setEndShiftOpen] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [roleSwitchOpen, setRoleSwitchOpen] = useState(false);
  const [isSwitchingRole, setIsSwitchingRole] = useState(false);

  // Only fetch the session load buckets once the driver has opened the
  // End shift sheet — avoids a second subscription on every More-tab
  // visit when the driver isn't about to end their shift.
  const sessionLoads = useQuery(
    api.driverMobile.getSessionLoads,
    endShiftOpen && activeSession ? { sessionId: activeSession._id } : 'skip',
  );

  // All-session counts: completed this shift + still in progress.
  // Drivers think "I worked 3 loads today", not "I finished 2 out of 3".
  const shiftSummary = useMemo(() => {
    if (!sessionLoads) return null;
    const rows = [
      ...sessionLoads.inProgress,
      ...sessionLoads.completedThisSession,
    ];
    const loads = rows.length;
    const miles = rows.reduce(
      (acc: number, r: { effectiveMiles?: number }) => acc + (r.effectiveMiles ?? 0),
      0,
    );
    const stops = rows.reduce(
      (acc: number, r: { stopCount?: number }) => acc + (r.stopCount ?? 0),
      0,
    );
    return {
      loads: String(loads),
      miles: miles > 0 ? Math.round(miles).toLocaleString() : '0',
      stops: String(stops),
    };
  }, [sessionLoads]);

  const appVersion = Application.nativeApplicationVersion ?? '1.0.0';
  const buildNumber = Application.nativeBuildVersion ?? '?';
  const otaUpdateId = Updates.updateId;
  const isEmbeddedLaunch = Updates.isEmbeddedLaunch;
  const otaShortId = otaUpdateId ? otaUpdateId.slice(0, 8) : null;

  const onDuty = !!activeSession;
  const elapsedLabel = formatElapsed(activeSession?.startedAt);
  const startedLabel = formatClock(activeSession?.startedAt);

  const handleEndShift = async () => {
    if (!activeSession) return;
    setIsEnding(true);
    try {
      await endSessionMutation({
        sessionId: activeSession._id,
        endReason: 'driver_manual',
      });
      await stopSessionTracking();
      posthog?.capture('shift_ended', {
        sessionId: activeSession._id,
        elapsedMs: activeSession.startedAt
          ? Date.now() - new Date(activeSession.startedAt).getTime()
          : null,
      });
      setEndShiftOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to end shift';
      posthog?.capture('shift_end_failed', { error: msg });
      Alert.alert(
        "Couldn't end shift",
        `${msg}\n\nTry again, or contact dispatch if this keeps happening.`,
      );
    } finally {
      setIsEnding(false);
    }
  };

  const handleSignOut = async () => {
    posthog?.capture('sign_out');
    setSignOutOpen(false);
    try {
      await signOut();
    } catch (err) {
      console.error('[More] signOut failed:', err);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Sign out"
          onPress={() => setSignOutOpen(true)}
          style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="logout" size={22} color={palette.danger} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Shift card — hero */}
        <View
          style={[
            styles.card,
            onDuty && { borderColor: 'rgba(16,185,129,0.35)' },
          ]}
        >
          {onDuty && <View style={styles.onDutyGlow} />}
          <View style={styles.shiftRow}>
            <View
              style={[
                styles.shiftDot,
                { backgroundColor: onDuty ? 'rgba(16,185,129,0.14)' : palette.bgMuted },
              ]}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  backgroundColor: onDuty ? palette.success : palette.textTertiary,
                }}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={[
                  styles.eyebrow,
                  { color: onDuty ? palette.success : palette.textTertiary },
                ]}
              >
                {onDuty ? 'ON DUTY' : 'OFF DUTY'}
              </Text>
              <Text style={styles.shiftTitle} numberOfLines={1}>
                {onDuty ? `${elapsedLabel} elapsed` : 'Not tracking'}
              </Text>
              <Text style={styles.shiftMeta} numberOfLines={1}>
                {onDuty ? `Started ${startedLabel}` : 'Ready when you are'}
              </Text>
            </View>
            {onDuty ? (
              <Pressable
                onPress={() => setEndShiftOpen(true)}
                style={({ pressed }) => [
                  styles.endShiftBtn,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.endShiftBtnText}>End shift</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push('/switch-truck')}
                style={({ pressed }) => [
                  styles.startShiftBtn,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Icon name="play" size={13} color="#fff" />
                <Text style={styles.startShiftBtnText}>Start shift</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Truck card */}
        <View style={[styles.card, { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={styles.truckIcon}>
            <Icon name="truck" size={20} color={palette.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.eyebrow}>CURRENT TRUCK</Text>
            <Text style={styles.truckTitle} numberOfLines={1}>
              {truck
                ? [truck.make, truck.model].filter(Boolean).join(' ') || `Unit ${truck.unitId}`
                : 'No truck assigned'}
            </Text>
            <Text style={styles.truckMeta} numberOfLines={1}>
              {truck ? `Unit ${truck.unitId}` : 'Scan your truck QR to pair'}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/switch-truck')}
            style={({ pressed }) => [
              styles.changeBtn,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Icon name="qr" size={14} color={palette.accent} />
            <Text style={styles.changeBtnText}>{truck ? 'Change' : 'Pair'}</Text>
          </Pressable>
        </View>

        {/* Drill-ins */}
        <View style={{ marginTop: 14, gap: 10 }}>
          {canSwitchModes && (
            <DrillRow
              palette={palette}
              icon="truck-swap"
              label="Switch role"
              // Dynamic meta reflecting the active role + its org so the
              // row communicates state without a tap. Mirrors the design
              // (DrillRow.meta = currentRoleLabel(currentRoleId)).
              meta={
                mode === 'driver'
                  ? `Driver · ${roles?.driverOrgName ?? 'Your organization'}`
                  : `Dispatcher · ${roles?.carrierOrgName ?? 'Your organization'}`
              }
              onPress={() => setRoleSwitchOpen(true)}
            />
          )}
          <DrillRow
            palette={palette}
            icon="settings"
            label="App settings"
            meta="Language, notifications, permissions"
            onPress={() => router.push('/app-settings')}
          />
          <DrillRow
            palette={palette}
            icon="info"
            label="Help & support"
            meta="Help center · Report a bug"
            onPress={() =>
              Alert.alert('Help & support', 'Contact your dispatcher for assistance.')
            }
          />
          <DrillRow
            palette={palette}
            icon="info"
            label="About"
            meta={`v${appVersion} · Terms & Privacy`}
            onPress={() =>
              Alert.alert(
                'About Otoqa',
                `Driver app · v${appVersion} (${buildNumber})\nTerms and privacy at otoqa.com`,
              )
            }
          />
        </View>

        {/* App info (read-only) */}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>APP INFO</Text>
        </View>
        <View style={styles.rowCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>Version</Text>
            <Text style={styles.infoValue}>
              v{appVersion} ({buildNumber})
            </Text>
          </View>
          {!isEmbeddedLaunch && otaShortId && (
            <>
              <RowDivider palette={palette} />
              <View style={styles.infoRow}>
                <Text style={styles.infoKey}>OTA</Text>
                <Text style={styles.infoValue}>{otaShortId}</Text>
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <SignOutSheet
        visible={signOutOpen}
        palette={palette}
        onConfirm={handleSignOut}
        onCancel={() => setSignOutOpen(false)}
      />
      <EndShiftSheet
        visible={endShiftOpen}
        palette={palette}
        elapsedLabel={elapsedLabel}
        startedLabel={startedLabel}
        loadsLabel={shiftSummary?.loads ?? '—'}
        milesLabel={shiftSummary?.miles ?? '—'}
        stopsLabel={shiftSummary?.stops ?? '—'}
        isEnding={isEnding}
        onConfirm={handleEndShift}
        onCancel={() => setEndShiftOpen(false)}
      />
      <RoleSwitchSheet
        visible={roleSwitchOpen}
        palette={palette}
        currentMode={mode}
        availableDriver={roles?.isDriver ?? false}
        availableOwner={roles?.isCarrierOwner ?? false}
        driverOrgName={roles?.driverOrgName ?? null}
        carrierOrgName={roles?.carrierOrgName ?? null}
        onDuty={onDuty}
        isSwitching={isSwitchingRole}
        onConfirm={async (picked) => {
          if (picked === mode) {
            // Defensive — the sheet button is disabled in this case
            // but guard in case anything slips through.
            setRoleSwitchOpen(false);
            return;
          }
          setIsSwitchingRole(true);
          try {
            // End the active shift before flipping role. The design
            // subtitle ("You'll end this shift before switching.")
            // promises this, and session state is tied to the driver
            // mode — carrying it across a role change would leave the
            // shift tracking against the wrong context.
            if (onDuty && activeSession) {
              await endSessionMutation({
                sessionId: activeSession._id,
                endReason: 'role_switch',
              });
              await stopSessionTracking();
              posthog?.capture('shift_ended', {
                sessionId: activeSession._id,
                reason: 'role_switch',
              });
            }
            await setMode(picked);
            posthog?.capture('role_switched', { from: mode, to: picked });
            setRoleSwitchOpen(false);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Switch failed';
            Alert.alert(
              "Couldn't switch role",
              `${msg}\n\nTry again, or contact dispatch if this keeps happening.`,
            );
          } finally {
            setIsSwitchingRole(false);
          }
        }}
        onCancel={() => setRoleSwitchOpen(false)}
      />
    </SafeAreaView>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function DrillRow({
  palette,
  icon,
  label,
  meta,
  onPress,
}: {
  palette: Palette;
  icon: IconName;
  label: string;
  meta: string;
  onPress: () => void;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={{ marginTop: 10 }}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.drillRow,
          pressed && { opacity: 0.85 },
        ]}
      >
        <View style={styles.drillIcon}>
          <Icon name={icon} size={18} color={palette.textSecondary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.drillLabel}>{label}</Text>
          <Text style={styles.drillMeta} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <Icon name="chevron-right" size={16} color={palette.textTertiary} />
      </Pressable>
    </View>
  );
}

function RowDivider({ palette }: { palette: Palette }) {
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: palette.borderSubtle,
        marginLeft: 54,
      }}
    />
  );
}

function SheetFrame({
  palette,
  onCancel,
  children,
}: {
  palette: Palette;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  // The Modal sits above all SafeAreaView providers, so we have to pull
  // insets here and pad the sheet body. iOS home-indicator is ~34px; on
  // Android gesture phones inset.bottom is 0–16, on 3-button nav it's
  // 48+. `Math.max` keeps iOS looking identical while pushing the CTA
  // clear of the Android nav bar.
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.sheetOverlay}>
      <Pressable style={styles.sheetBackdrop} onPress={onCancel} />
      <View style={[styles.sheetBody, { paddingBottom: Math.max(insets.bottom + 12, 24) }]}>
        <View style={styles.sheetHandle} />
        {children}
      </View>
    </View>
  );
}

function SignOutSheet({
  visible,
  palette,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  palette: Palette;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <SheetFrame palette={palette} onCancel={onCancel}>
        <View
          style={[
            styles.sheetIcon,
            { backgroundColor: 'rgba(239, 68, 68, 0.12)' },
          ]}
        >
          <Icon name="logout" size={22} color={palette.danger} />
        </View>
        <Text style={styles.sheetTitle}>Sign out of Otoqa?</Text>
        <Text style={styles.sheetBodyText}>
          You&apos;ll need to scan your truck QR again when you sign back in.
        </Text>
        <View style={{ gap: 10, marginTop: 18, alignSelf: 'stretch' }}>
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => [
              styles.sheetCta,
              { backgroundColor: palette.danger },
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={styles.sheetCtaText}>Sign out</Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [
              styles.sheetCtaSecondary,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.sheetCtaSecondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </SheetFrame>
    </Modal>
  );
}

function EndShiftSheet({
  visible,
  palette,
  elapsedLabel,
  startedLabel,
  loadsLabel,
  milesLabel,
  stopsLabel,
  isEnding,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  palette: Palette;
  elapsedLabel: string;
  startedLabel: string;
  loadsLabel: string;
  milesLabel: string;
  stopsLabel: string;
  isEnding: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const endingLabel = formatClock(Date.now());
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <SheetFrame palette={palette} onCancel={onCancel}>
        <View
          style={[
            styles.sheetIcon,
            { backgroundColor: 'rgba(16,185,129,0.12)' },
          ]}
        >
          <Icon name="check" size={22} color={palette.success} strokeWidth={2.5} />
        </View>
        <Text style={styles.sheetTitle}>End shift?</Text>
        <Text style={styles.sheetBodyText}>
          Tracking will pause and your timesheet will log out. You&apos;ll stay signed
          in and can start a new shift anytime.
        </Text>

        <View style={styles.statsGrid}>
          <ShiftStat palette={palette} label="Elapsed" value={elapsedLabel} />
          <ShiftStat palette={palette} label="Loads" value={loadsLabel} />
          <ShiftStat palette={palette} label="Miles" value={milesLabel} />
          <ShiftStat palette={palette} label="Stops" value={stopsLabel} />
        </View>
        <Text style={styles.statsFooter}>
          Started {startedLabel} · Ending {endingLabel}
        </Text>

        <View style={{ gap: 10, marginTop: 18, alignSelf: 'stretch' }}>
          <Pressable
            onPress={onConfirm}
            disabled={isEnding}
            style={({ pressed }) => [
              styles.sheetCta,
              { backgroundColor: palette.accent },
              pressed && !isEnding && { opacity: 0.9 },
              isEnding && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.sheetCtaText}>{isEnding ? 'Ending…' : 'End shift'}</Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            disabled={isEnding}
            style={({ pressed }) => [
              styles.sheetCtaSecondary,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.sheetCtaSecondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </SheetFrame>
    </Modal>
  );
}

const ShiftStat: React.FC<{ palette: Palette; label: string; value: string }> = ({
  palette,
  label,
  value,
}) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label.toUpperCase()}</Text>
    </View>
  );
};

// ============================================================================
// ROLE SWITCH SHEET — compact in-session switcher
// ============================================================================
//
// Ported from lib/role-switch-screen.jsx's `RoleSwitchSheet` variant.
// Tighter than the full-screen `/role-switch` chooser: compact rows,
// current role gets an "Active" pill, CTA is disabled when the picked
// role IS the current one. Subtitle warns that switching ends the shift
// (the parent's onConfirm handles that end-session + setMode sequence).

type RoleChoice = 'driver' | 'owner';

interface RoleOption {
  id: RoleChoice;
  label: string;
  tagline: string;
  icon: IconName;
  accent: string;
  tint: string;
}

const ROLE_OPTIONS: Record<RoleChoice, RoleOption> = {
  driver: {
    id: 'driver',
    label: 'Driver',
    tagline: 'Drive loads · Log your shift',
    icon: 'truck',
    accent: '#2E5CFF',
    tint: 'rgba(46, 92, 255, 0.12)',
  },
  owner: {
    id: 'owner',
    label: 'Dispatcher',
    tagline: 'Manage fleet · Assign loads',
    icon: 'layout',
    accent: '#7C3AED',
    tint: 'rgba(124, 58, 237, 0.12)',
  },
};

function RoleSwitchSheet({
  visible,
  palette,
  currentMode,
  availableDriver,
  availableOwner,
  driverOrgName,
  carrierOrgName,
  onDuty,
  isSwitching,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  palette: Palette;
  currentMode: RoleChoice;
  availableDriver: boolean;
  availableOwner: boolean;
  driverOrgName: string | null;
  carrierOrgName: string | null;
  onDuty: boolean;
  isSwitching: boolean;
  onConfirm: (picked: RoleChoice) => void;
  onCancel: () => void;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  // Default the selection to the CURRENT role so accidental opens don't
  // pre-select a role swap. Reset each time the sheet re-opens.
  const [picked, setPicked] = useState<RoleChoice>(currentMode);
  useEffect(() => {
    if (visible) setPicked(currentMode);
  }, [visible, currentMode]);

  const choices: RoleChoice[] = [];
  if (availableDriver) choices.push('driver');
  if (availableOwner) choices.push('owner');

  const pickedDef = ROLE_OPTIONS[picked];
  const isSame = picked === currentMode;

  const orgNameFor = (id: RoleChoice) =>
    id === 'driver' ? driverOrgName : carrierOrgName;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <SheetFrame palette={palette} onCancel={onCancel}>
        <View style={[styles.roleSwitchHeader]}>
          <View style={[styles.roleSwitchHeaderIcon, { backgroundColor: palette.accentTint }]}>
            <Icon name="truck-swap" size={18} color={palette.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.sheetTitle}>Switch role</Text>
            <Text style={styles.roleSwitchSubtitle}>
              {onDuty
                ? "You'll end this shift before switching."
                : 'Pick the role you want to work in.'}
            </Text>
          </View>
        </View>

        {/* alignSelf: 'stretch' is mandatory because SheetFrame's body
            has alignItems: 'center' — without it the row column width
            collapses to the icon+radio combined, hiding label + meta. */}
        <View style={{ gap: 8, marginTop: 14, alignSelf: 'stretch' }}>
          {choices.map((id) => {
            const def = ROLE_OPTIONS[id];
            const selected = picked === id;
            const isCurrent = currentMode === id;
            return (
              <Pressable
                key={id}
                onPress={() => setPicked(id)}
                style={({ pressed }) => [
                  styles.roleRow,
                  selected && {
                    borderColor: def.accent,
                    shadowColor: def.accent,
                    shadowOpacity: 0.2,
                    shadowRadius: 6,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 2,
                  },
                  pressed && { opacity: 0.9 },
                ]}
              >
                <View style={[styles.roleRowIcon, { backgroundColor: def.tint }]}>
                  <Icon name={def.icon} size={19} color={def.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.roleRowTitleRow}>
                    <Text style={styles.roleRowLabel}>{def.label}</Text>
                    {isCurrent && (
                      <View style={styles.roleRowActivePill}>
                        <Text style={styles.roleRowActiveText}>ACTIVE</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.roleRowMeta} numberOfLines={1}>
                    {orgNameFor(id) ?? def.tagline}
                  </Text>
                </View>
                <View
                  style={[
                    styles.roleRowRadio,
                    selected && {
                      borderColor: def.accent,
                      backgroundColor: def.accent,
                    },
                  ]}
                >
                  {selected && (
                    <Icon name="check" size={12} color="#fff" strokeWidth={2.5} />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: 10, marginTop: 16, alignSelf: 'stretch' }}>
          <Pressable
            onPress={() => onConfirm(picked)}
            disabled={isSame || isSwitching}
            style={({ pressed }) => [
              styles.sheetCta,
              {
                backgroundColor: isSame ? palette.bgMuted : pickedDef.accent,
              },
              pressed && !isSame && !isSwitching && { opacity: 0.9 },
              isSwitching && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.sheetCtaText,
                isSame && { color: palette.textTertiary },
              ]}
            >
              {isSame
                ? `Already in ${pickedDef.label}`
                : isSwitching
                  ? 'Switching…'
                  : `Switch to ${pickedDef.label}`}
            </Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            disabled={isSwitching}
            style={({ pressed }) => [
              styles.sheetCtaSecondary,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.sheetCtaSecondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </SheetFrame>
    </Modal>
  );
}

// ============================================================================
// UTILS
// ============================================================================

function formatClock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatElapsed(startedAtMs?: number): string {
  if (!startedAtMs) return '0h 00m';
  const diffMs = Date.now() - startedAtMs;
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${hours}h ${mins.toString().padStart(2, '0')}m`;
}

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    header: {
      height: 52,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    headerBtn: {
      width: 44,
      height: 44,
      borderRadius: radii.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    scroll: {
      flex: 1,
      paddingHorizontal: sp.screenPx,
    },
    eyebrow: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    card: {
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      padding: sp.cardPadding,
      position: 'relative',
      overflow: 'hidden',
    },
    onDutyGlow: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2,
      backgroundColor: palette.success,
      opacity: 0.4,
    },
    shiftRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    shiftDot: {
      width: 36,
      height: 36,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    shiftTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.textPrimary,
      marginTop: 2,
      fontVariant: ['tabular-nums'],
    },
    shiftMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 1,
    },
    endShiftBtn: {
      height: 38,
      paddingHorizontal: 14,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    endShiftBtnText: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    startShiftBtn: {
      height: 38,
      paddingHorizontal: 16,
      borderRadius: radii.md,
      backgroundColor: palette.accent,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    startShiftBtnText: {
      fontSize: 13,
      fontWeight: '600',
      color: '#fff',
    },
    truckIcon: {
      width: 40,
      height: 40,
      borderRadius: radii.md,
      backgroundColor: palette.accentTint,
      alignItems: 'center',
      justifyContent: 'center',
    },
    truckTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
      marginTop: 2,
    },
    truckMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 1,
    },
    changeBtn: {
      height: 34,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.accent,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    changeBtnText: {
      fontSize: 12,
      fontWeight: '600',
      color: palette.accent,
    },
    drillRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: sp.listPy,
      paddingHorizontal: sp.listPx,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
    },
    drillIcon: {
      width: 32,
      height: 32,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    drillLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    drillMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 2,
    },

    // App settings + App info sections
    sectionHead: {
      paddingTop: 24,
      paddingBottom: 8,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    rowCard: {
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      borderRadius: radii.lg,
      overflow: 'hidden',
    },
    settingsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    settingsRowIcon: {
      width: 28,
      height: 28,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    settingsRowLabel: {
      flex: 1,
      fontSize: 14,
      color: palette.textPrimary,
      fontWeight: '500',
    },
    settingsRowValue: {
      fontSize: 13,
      color: palette.textTertiary,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    infoKey: {
      fontSize: 13,
      color: palette.textTertiary,
    },
    infoValue: {
      fontSize: 13,
      fontWeight: '500',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },

    // Sheets
    sheetOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheetBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    sheetBody: {
      backgroundColor: palette.bgSurface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      padding: 18,
      // paddingBottom is applied inline from useSafeAreaInsets in SheetFrame
      alignItems: 'center',
    },
    sheetHandle: {
      width: 38,
      height: 4,
      borderRadius: 99,
      backgroundColor: palette.borderDefault,
      marginBottom: 16,
    },
    sheetIcon: {
      width: 52,
      height: 52,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    sheetTitle: {
      ...typeScale.headingSm,
      color: palette.textPrimary,
      textAlign: 'center',
    },
    sheetBodyText: {
      fontSize: 13,
      lineHeight: 18,
      color: palette.textSecondary,
      textAlign: 'center',
      marginTop: 8,
      paddingHorizontal: 8,
    },
    statsGrid: {
      marginTop: 16,
      padding: 12,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignSelf: 'stretch',
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 8,
    },
    statCell: {
      flex: 1,
      alignItems: 'center',
    },
    statValue: {
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: -0.16,
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    statLabel: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.6,
      color: palette.textTertiary,
      marginTop: 2,
    },
    statsFooter: {
      marginTop: 8,
      fontSize: 11,
      color: palette.textTertiary,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    sheetCta: {
      alignSelf: 'stretch',
      height: 48,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetCtaText: {
      fontSize: 15,
      fontWeight: '600',
      color: '#fff',
    },
    sheetCtaSecondary: {
      alignSelf: 'stretch',
      height: 48,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetCtaSecondaryText: {
      fontSize: 15,
      fontWeight: '500',
      color: palette.textPrimary,
    },

    // Role switch sheet ────────────────────────────────────────
    roleSwitchHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      alignSelf: 'stretch',
    },
    roleSwitchHeaderIcon: {
      width: 34,
      height: 34,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roleSwitchSubtitle: {
      fontSize: 12,
      color: palette.textTertiary,
      marginTop: 2,
    },
    roleRow: {
      // Explicit stretch so the row pulls its column middle (label +
      // meta) across the available width. Without this some RN versions
      // leave the row at content-width, collapsing the flex:1 middle
      // column and hiding the label entirely.
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1.5,
      borderColor: palette.borderSubtle,
    },
    roleRowIcon: {
      width: 38,
      height: 38,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roleRowTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    roleRowLabel: {
      fontSize: 14,
      fontWeight: '700',
      letterSpacing: -0.1,
      color: palette.textPrimary,
    },
    roleRowActivePill: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radii.full,
      backgroundColor: palette.success,
    },
    roleRowActiveText: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: '#fff',
    },
    roleRowMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 1,
    },
    roleRowRadio: {
      width: 22,
      height: 22,
      borderRadius: 999,
      borderWidth: 1.5,
      borderColor: palette.borderDefault,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
