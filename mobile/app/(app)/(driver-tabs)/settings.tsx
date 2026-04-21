/**
 * Profile tab — Otoqa Driver design system.
 *
 * Ports lib/profile-screen.jsx: CDL-style identity hero, license detail
 * rows, and three tiles (Payroll / Compliance / Documents). Payroll,
 * Compliance and Documents tiles are placeholders until their backends
 * land; they drill into screens that don't exist yet and show "Coming
 * soon" state.
 *
 * App preferences that used to live here (language, appearance, role
 * switch, version info) are kept as a secondary "App settings" block
 * below the tiles so they still have a home — the standalone App
 * Settings drill-in from the More tab is part of the next batch.
 */
import React, { useMemo } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useDriver } from '../_layout';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import { Icon } from '../../../lib/design-icons';
import { densitySpacing, radii, type Palette } from '../../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

export default function ProfileScreen() {
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const { driverId } = useDriver();
  const profile = useQuery(
    api.driverMobile.getMyProfile,
    driverId ? { driverId: driverId as Id<'drivers'> } : 'skip',
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <LicenseHero palette={palette} profile={profile} />

        <LicenseDetails palette={palette} profile={profile} />

        <ProfileTiles
          palette={palette}
          onOpenPayroll={() =>
            Alert.alert('Payroll', 'Payroll is coming soon.')
          }
          onOpenCompliance={() =>
            Alert.alert('Compliance', 'Compliance is coming soon.')
          }
          onOpenDocs={() =>
            Alert.alert('Documents', 'Documents are coming soon.')
          }
        />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// IDENTITY HERO — CDL-style gradient card
// ============================================================================

function LicenseHero({ palette, profile }: { palette: Palette; profile: any }) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const firstName = (profile?.firstName ?? 'Driver').toString();
  const lastName = (profile?.lastName ?? '').toString();
  const initials = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
  const licenseNumber = profile?.licenseNumber ?? '—';
  const licenseClass = profile?.licenseClass ?? 'CDL';
  const licenseState = profile?.licenseState ?? '—';
  const expiration = formatDateShort(profile?.licenseExpiration);
  const medicalExpiration = profile?.medicalExpiration;
  const medicalState = classifyExpiration(medicalExpiration);

  return (
    <View style={{ paddingHorizontal: sp.screenPx, paddingTop: sp.sectionGap }}>
      <LinearGradient
        colors={['#1D355C', '#2E5CFF', '#5C82FF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.licenseCard}
      >
        <View style={styles.licenseTopRow}>
          <View>
            <Text style={styles.licenseStateLabel}>
              {(licenseState || '—').toUpperCase()} · USA
            </Text>
            <Text style={styles.licenseTypeLabel}>COMMERCIAL DRIVER LICENSE</Text>
          </View>
          <View style={styles.licenseStatusPill}>
            <View
              style={[
                styles.licenseStatusDot,
                {
                  backgroundColor:
                    medicalState === 'bad'
                      ? '#FECACA'
                      : medicalState === 'warn'
                        ? '#FEF3C7'
                        : '#6EE7B7',
                },
              ]}
            />
            <Text style={styles.licenseStatusLabel}>
              {medicalState === 'bad'
                ? 'Expired'
                : medicalState === 'warn'
                  ? 'Medical due'
                  : 'Active'}
            </Text>
          </View>
        </View>

        <View style={styles.licenseMidRow}>
          <View style={styles.licensePhotoTile}>
            <Text style={styles.licensePhotoInitials}>{initials || 'DR'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.licenseFieldLabel}>LN</Text>
            <Text style={styles.licenseLastName} numberOfLines={1}>
              {lastName.toUpperCase()}
            </Text>
            <Text style={[styles.licenseFieldLabel, { marginTop: 6 }]}>FN</Text>
            <Text style={styles.licenseFirstName} numberOfLines={1}>
              {firstName.toUpperCase()}
            </Text>
          </View>
        </View>

        <View style={styles.licenseBottomRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.licenseFieldLabel}>DL</Text>
            <Text style={styles.licenseFieldValue}>{licenseNumber}</Text>
          </View>
          <View>
            <Text style={styles.licenseFieldLabel}>CLASS</Text>
            <Text style={styles.licenseFieldValue}>{licenseClass}</Text>
          </View>
          <View>
            <Text style={[styles.licenseFieldLabel, { textAlign: 'right' }]}>EXP</Text>
            <Text style={[styles.licenseFieldValue, { textAlign: 'right' }]}>
              {expiration}
            </Text>
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

// ============================================================================
// LICENSE DETAILS
// ============================================================================

function LicenseDetails({ palette, profile }: { palette: Palette; profile: any }) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const medicalState = classifyExpiration(profile?.medicalExpiration);
  const medicalColor =
    medicalState === 'bad' ? palette.danger : medicalState === 'warn' ? palette.warning : palette.textPrimary;
  const medicalText =
    medicalState === 'bad'
      ? `Expired ${formatDateShort(profile?.medicalExpiration)}`
      : medicalState === 'warn'
        ? `Expires ${formatDateShort(profile?.medicalExpiration)}`
        : formatDateShort(profile?.medicalExpiration) || '—';

  const rows: Array<{ k: string; v: string; color?: string }> = [
    { k: 'Issued by', v: profile?.licenseState ? `${profile.licenseState} DMV` : '—' },
    { k: 'License expires', v: formatDateShort(profile?.licenseExpiration) || '—' },
    { k: 'Medical card', v: medicalText, color: medicalColor },
  ];

  return (
    <View style={{ paddingHorizontal: sp.screenPx, paddingTop: sp.sectionGap }}>
      <View style={styles.detailsCard}>
        {rows.map((row, i) => (
          <View key={row.k}>
            {i > 0 && <RowDivider palette={palette} />}
            <View style={styles.detailRow}>
              <Text style={styles.detailKey}>{row.k}</Text>
              <Text
                style={[styles.detailValue, row.color && { color: row.color }]}
                numberOfLines={1}
              >
                {row.v}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================================
// TILES
// ============================================================================

function ProfileTiles({
  palette,
  onOpenPayroll,
  onOpenCompliance,
  onOpenDocs,
}: {
  palette: Palette;
  onOpenPayroll: () => void;
  onOpenCompliance: () => void;
  onOpenDocs: () => void;
}) {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={{ paddingHorizontal: sp.screenPx, paddingTop: sp.sectionGap, gap: 8 }}>
      <Pressable
        onPress={onOpenPayroll}
        style={({ pressed }) => [styles.wideTile, pressed && { opacity: 0.9 }]}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.tileHeader}>
            <Icon name="dollar" size={14} color={palette.accent} />
            <Text style={styles.tileEyebrow}>PAYROLL · THIS WEEK</Text>
          </View>
          <Text style={styles.tileValueLg}>—</Text>
          <Text style={styles.tileSub}>Coming soon</Text>
        </View>
        <Icon name="chevron-right" size={20} color={palette.textTertiary} />
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={onOpenCompliance}
          style={({ pressed }) => [styles.splitTile, pressed && { opacity: 0.9 }]}
        >
          <View style={styles.tileHeader}>
            <Icon name="check-circle" size={14} color={palette.accent} />
            <Text style={styles.tileEyebrow}>COMPLIANCE</Text>
          </View>
          <Text style={styles.tileValueMd}>—</Text>
          <Text style={styles.tileSub}>Coming soon</Text>
        </Pressable>
        <Pressable
          onPress={onOpenDocs}
          style={({ pressed }) => [styles.splitTile, pressed && { opacity: 0.9 }]}
        >
          <View style={styles.tileHeader}>
            <Icon name="clipboard" size={14} color={palette.accent} />
            <Text style={styles.tileEyebrow}>DOCUMENTS</Text>
          </View>
          <Text style={styles.tileValueMd}>—</Text>
          <Text style={styles.tileSub}>Coming soon</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// ROW DIVIDER (used inside LicenseDetails)
// ============================================================================

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

// ============================================================================
// UTILS
// ============================================================================

function formatDateShort(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function classifyExpiration(iso?: string): 'ok' | 'warn' | 'bad' {
  if (!iso) return 'ok';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'ok';
  const now = Date.now();
  const diffDays = (d.getTime() - now) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return 'bad';
  if (diffDays < 30) return 'warn';
  return 'ok';
}

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },

    // License hero
    licenseCard: {
      aspectRatio: 1.586 / 1,
      borderRadius: 20,
      padding: 18,
      overflow: 'hidden',
    },
    licenseTopRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 10,
    },
    licenseStateLabel: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 1.1,
      color: 'rgba(255,255,255,0.85)',
    },
    licenseTypeLabel: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.8,
      color: 'rgba(255,255,255,0.7)',
      marginTop: 2,
    },
    licenseStatusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: 'rgba(16,185,129,0.9)',
    },
    licenseStatusDot: {
      width: 6,
      height: 6,
      borderRadius: 999,
    },
    licenseStatusLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.3,
      color: '#fff',
    },
    licenseMidRow: {
      flexDirection: 'row',
      gap: 12,
      alignItems: 'flex-start',
      flex: 1,
    },
    licensePhotoTile: {
      width: 58,
      height: 74,
      borderRadius: 6,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.28)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    licensePhotoInitials: {
      fontSize: 22,
      fontWeight: '700',
      color: '#fff',
      letterSpacing: -0.01,
    },
    licenseFieldLabel: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 1,
      color: 'rgba(255,255,255,0.7)',
    },
    licenseLastName: {
      fontSize: 17,
      fontWeight: '700',
      color: '#fff',
      letterSpacing: -0.01,
    },
    licenseFirstName: {
      fontSize: 15,
      fontWeight: '600',
      color: '#fff',
    },
    licenseBottomRow: {
      flexDirection: 'row',
      gap: 10,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: 'rgba(255,255,255,0.2)',
    },
    licenseFieldValue: {
      fontSize: 13,
      fontWeight: '600',
      color: '#fff',
      fontVariant: ['tabular-nums'],
    },

    // License details
    detailsCard: {
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      borderRadius: radii.lg,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    detailKey: {
      fontSize: 13,
      color: palette.textTertiary,
    },
    detailValue: {
      fontSize: 13,
      fontWeight: '500',
      color: palette.textPrimary,
      flex: 1,
      textAlign: 'right',
    },

    // Tiles
    tileHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    tileEyebrow: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    tileValueLg: {
      fontSize: 24,
      fontWeight: '700',
      letterSpacing: -0.24,
      color: palette.textPrimary,
      marginTop: 4,
      fontVariant: ['tabular-nums'],
    },
    tileValueMd: {
      fontSize: 22,
      fontWeight: '700',
      color: palette.textPrimary,
      marginTop: 6,
      fontVariant: ['tabular-nums'],
    },
    tileSub: {
      fontSize: 12,
      color: palette.textTertiary,
      marginTop: 2,
    },
    wideTile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 16,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
    },
    splitTile: {
      flex: 1,
      padding: 14,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      minHeight: 108,
    },

    // Section heads + rows
    sectionHead: {
      paddingHorizontal: 16,
      paddingTop: 28,
      paddingBottom: 8,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    rowCard: {
      marginHorizontal: 16,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      borderRadius: radii.lg,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    rowIcon: {
      width: 28,
      height: 28,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowLabel: {
      flex: 1,
      fontSize: 14,
      color: palette.textPrimary,
      fontWeight: '500',
    },
    rowValue: {
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
  });
