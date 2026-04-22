/**
 * Role Switch — Otoqa Driver design system (port of lib/role-switch-screen.jsx).
 *
 * Full-screen role chooser for users who have both a driver and a
 * dispatcher account. Shown:
 *   - After sign-in when `useAppMode().canSwitchModes` is true
 *   - From the More tab as a drill-in
 *
 * Design rules from the chat transcript:
 *   - Name in header + Sign out, nothing else (no email, no avatar)
 *   - No "Remember my choice" toggle
 *   - Role cards show motif, icon, label, tagline, org row, last-used
 *     chip. No live meta strip (load count / driver count).
 *   - Name reads 18px/700.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Circle, G, Defs, RadialGradient, Stop } from 'react-native-svg';
import { useRouter, router as globalRouter } from 'expo-router';
import { useClerk } from '@clerk/clerk-expo';
import { useAppMode } from './_layout';
import { useDriver } from './_layout';
import { Icon } from '../../lib/design-icons';
import { useTheme } from '../../lib/ThemeContext';
import { useDensityTokens } from '../../lib/density';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

type RoleId = 'driver' | 'owner';

interface RoleDef {
  id: RoleId;
  label: string;
  tagline: string;
  accent: string;
  tint: string;
}

const ROLE_DEFS: Record<RoleId, RoleDef> = {
  driver: {
    id: 'driver',
    label: 'Driver',
    tagline: 'Drive loads · Log your shift',
    accent: '#2E5CFF',
    tint: 'rgba(46, 92, 255, 0.12)',
  },
  owner: {
    id: 'owner',
    label: 'Dispatcher',
    tagline: 'Manage fleet · Assign loads',
    accent: '#7C3AED',
    tint: 'rgba(124, 58, 237, 0.12)',
  },
};

export default function RoleSwitchScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);
  const { signOut } = useClerk();
  const { mode, setMode, roles } = useAppMode();
  const { driverName } = useDriver();

  const [picked, setPicked] = useState<RoleId>(mode);

  // Build the role list off live app-mode data. A user might only have
  // one role; in that case this screen shouldn't have been reachable
  // but guard anyway so we never render 0 cards.
  const availableRoles: RoleId[] = [];
  if (roles?.isDriver) availableRoles.push('driver');
  if (roles?.isCarrierOwner) availableRoles.push('owner');
  if (availableRoles.length === 0) {
    availableRoles.push('driver', 'owner'); // fallback: show both
  }

  const [isContinuing, setIsContinuing] = useState(false);

  // Fully instrumented async handler so every step is visible in Metro
  // if navigation fails. Each log is prefixed [RoleSwitch:] so the
  // sequence can be grep'd out of the verbose RN log stream.
  const handleContinue = async () => {
    console.log('[RoleSwitch:1] Continue pressed — picked:', picked);
    if (isContinuing) {
      console.log('[RoleSwitch:1a] Already continuing, skip');
      return;
    }
    setIsContinuing(true);

    const target =
      picked === 'driver' ? '/(app)/(driver-tabs)' : '/(app)/owner';

    try {
      console.log('[RoleSwitch:2] About to call setMode');
      const result = setMode(picked);
      console.log('[RoleSwitch:3] setMode returned, type:', typeof result, 'isPromise:', result instanceof Promise);

      if (result instanceof Promise) {
        console.log('[RoleSwitch:4] Awaiting setMode promise…');
        await result;
        console.log('[RoleSwitch:5] setMode promise resolved');
      }

      // Let React commit all pending state updates and run the parent's
      // navigation effect. A 50ms delay is plenty for React 18 to flush.
      console.log('[RoleSwitch:6] Waiting 50ms for state commit');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try both routers — local hook router and the global router
      // singleton. If one is stale or unbound in this render context,
      // the other should catch it.
      console.log('[RoleSwitch:7] Calling router.replace →', target);
      try {
        router.replace(target);
        console.log('[RoleSwitch:8] router.replace call returned');
      } catch (navErr) {
        console.warn('[RoleSwitch:8!] router.replace threw:', navErr);
      }

      // Belt-and-suspenders: fire the global router singleton after one
      // more frame, in case the hook router was scoped to an unmounted
      // tree by that point.
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        console.log('[RoleSwitch:9] Calling globalRouter.replace →', target);
        globalRouter.replace(target);
        console.log('[RoleSwitch:10] globalRouter.replace call returned');
      } catch (navErr) {
        console.warn('[RoleSwitch:10!] globalRouter threw:', navErr);
      }
    } catch (err) {
      console.warn('[RoleSwitch:!] handleContinue failed:', err);
      Alert.alert(
        "Couldn't continue",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setTimeout(() => setIsContinuing(false), 1500);
    }
  };

  const pickedDef = ROLE_DEFS[picked];

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Two soft radial gradients — one per role, placed diagonally in
          opposite corners. Evokes "two doors" without the hard-edged
          circles the previous View-based implementation produced.
          pointerEvents is set on BOTH the wrapper View AND the SVG —
          react-native-svg's internal host views don't always honor a
          parent pointerEvents: 'none', so the SVG would absorb taps
          meant for the footer CTA below. Locking both layers ensures
          touches pass straight through to the Pressable. */}
      <View
        pointerEvents="none"
        style={[styles.ambientWash, { pointerEvents: 'none' }]}
      >
        <Svg
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          pointerEvents="none"
        >
          <Defs>
            <RadialGradient
              id="roleWashDriver"
              cx="18%"
              cy="12%"
              r="55%"
              fx="18%"
              fy="12%"
            >
              <Stop offset="0%" stopColor="#2E5CFF" stopOpacity={0.22} />
              <Stop offset="100%" stopColor="#2E5CFF" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient
              id="roleWashOwner"
              cx="86%"
              cy="88%"
              r="55%"
              fx="86%"
              fy="88%"
            >
              <Stop offset="0%" stopColor="#7C3AED" stopOpacity={0.18} />
              <Stop offset="100%" stopColor="#7C3AED" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill="url(#roleWashDriver)" />
          <Rect x={0} y={0} width="100%" height="100%" fill="url(#roleWashOwner)" />
        </Svg>
      </View>

      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {driverName || 'Driver'}
        </Text>
        <Pressable
          onPress={() => void signOut()}
          style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.heroWrap}>
        <Text style={styles.heroEyebrow}>CHOOSE HOW YOU'RE WORKING TODAY</Text>
        <Text style={styles.heroHeadline}>Which hat are you wearing?</Text>
        <Text style={styles.heroBody}>
          You can switch anytime from the More tab.
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.cards}
        showsVerticalScrollIndicator={false}
      >
        {availableRoles.map((id) => (
          <RoleCard
            key={id}
            palette={palette}
            role={ROLE_DEFS[id]}
            // Prefer the human-readable org name resolved on the server
            // (getUserRoles.driverOrgName / carrierOrgName). Fall back to
            // "Your organization" if the lookup didn't resolve — don't
            // show the raw Convex doc id in the UI.
            org={
              id === 'driver'
                ? roles?.driverOrgName ?? null
                : roles?.carrierOrgName ?? null
            }
            orgRole={id === 'driver' ? 'CDL-A Driver' : 'Dispatcher'}
            selected={picked === id}
            lastUsed={mode === id}
            onPick={() => setPicked(id)}
          />
        ))}

        {/* Continue CTA placed INSIDE the ScrollView's content. Card
            Pressables here register taps fine (user confirmed), but the
            same button rendered in a sibling footer View below the
            ScrollView was not receiving onPress at all. Keeping it in
            the same touch zone dodges whatever z-order / gesture
            handler issue was eating the footer taps. */}
        <TouchableOpacity
          onPress={handleContinue}
          onPressIn={() => console.log('[RoleSwitch] pressIn')}
          disabled={isContinuing}
          activeOpacity={0.85}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[
            styles.cta,
            { backgroundColor: pickedDef.accent, marginTop: 8 },
            isContinuing && { opacity: 0.7 },
          ]}
        >
          {isContinuing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.ctaInner}>
              <Text style={styles.ctaText}>
                Continue as {pickedDef.label}
              </Text>
              <Icon name="arrow-right" size={17} color="#fff" />
            </View>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// ROLE CARD
// ============================================================================

const RoleCard: React.FC<{
  palette: Palette;
  role: RoleDef;
  org: string | null;
  orgRole: string;
  selected: boolean;
  lastUsed: boolean;
  onPick: () => void;
}> = ({ palette, role, org, orgRole, selected, lastUsed, onPick }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <Pressable
      onPress={onPick}
      style={({ pressed }) => [
        styles.card,
        selected && {
          borderColor: role.accent,
          shadowColor: role.accent,
          shadowOpacity: 0.25,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        },
        pressed && { opacity: 0.95 },
      ]}
    >
      <RoleMotif roleId={role.id} color={role.accent} />

      <View style={styles.cardTopRow}>
        <View style={[styles.cardIcon, { backgroundColor: role.tint }]}>
          <Icon
            name={role.id === 'driver' ? 'truck' : 'layout'}
            size={22}
            color={role.accent}
          />
        </View>
        <View style={styles.cardTopRight}>
          {lastUsed && (
            <View style={styles.lastUsedPill}>
              <View style={styles.lastUsedDot} />
              <Text style={styles.lastUsedText}>LAST USED</Text>
            </View>
          )}
          <View
            style={[
              styles.radio,
              selected && {
                borderColor: role.accent,
                backgroundColor: role.accent,
              },
            ]}
          >
            {selected && (
              <Icon name="check" size={12} color="#fff" strokeWidth={2.5} />
            )}
          </View>
        </View>
      </View>

      <Text style={styles.cardLabel}>{role.label}</Text>
      <Text style={styles.cardTagline}>{role.tagline}</Text>

      <View style={styles.orgRow}>
        <View style={styles.orgIcon}>
          <Icon name="building" size={14} color={palette.textSecondary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.orgName} numberOfLines={1}>
            {org ?? 'Your organization'}
          </Text>
          <Text style={styles.orgRole} numberOfLines={1}>
            {orgRole}
          </Text>
        </View>
      </View>
    </Pressable>
  );
};

// ============================================================================
// ROLE MOTIF — decorative SVG in the top-right of each card
// ============================================================================

const RoleMotif: React.FC<{ roleId: RoleId; color: string }> = ({
  roleId,
  color,
}) => {
  if (roleId === 'driver') {
    return (
      <Svg
        width={160}
        height={100}
        viewBox="0 0 140 90"
        style={{
          position: 'absolute',
          right: -8,
          top: -2,
          opacity: 0.08,
        }}
      >
        <Path
          d="M2 40h30M8 52h22M14 28h18"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <Rect x="58" y="28" width="54" height="32" rx="3" fill={color} />
        <Path
          d="M112 38 L124 38 L132 46 L132 60 L112 60 Z"
          fill={color}
        />
        <Circle cx="72" cy="64" r="6" fill={color} />
        <Circle cx="120" cy="64" r="6" fill={color} />
      </Svg>
    );
  }
  return (
    <Svg
      width={150}
      height={98}
      viewBox="0 0 140 90"
      style={{
        position: 'absolute',
        right: -4,
        top: -4,
        opacity: 0.1,
      }}
    >
      <G fill={color}>
        <Rect x="60" y="6" width="22" height="14" rx="2" />
        <Rect x="86" y="6" width="34" height="14" rx="2" opacity={0.7} />
        <Rect x="60" y="24" width="38" height="14" rx="2" opacity={0.75} />
        <Rect x="102" y="24" width="18" height="14" rx="2" />
        <Rect x="60" y="42" width="18" height="14" rx="2" opacity={0.6} />
        <Rect x="82" y="42" width="26" height="14" rx="2" />
        <Rect x="112" y="42" width="12" height="14" rx="2" opacity={0.7} />
        <Rect x="60" y="60" width="30" height="14" rx="2" />
        <Rect x="94" y="60" width="26" height="14" rx="2" opacity={0.6} />
      </G>
    </Svg>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    ambientWash: {
      ...StyleSheet.absoluteFillObject,
    },

    header: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 8,
      paddingBottom: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    name: {
      flex: 1,
      fontSize: 18,
      fontWeight: '700',
      letterSpacing: -0.18,
      color: palette.textPrimary,
    },
    signOutBtn: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: radii.md,
    },
    signOutText: {
      fontSize: 12,
      fontWeight: '600',
      color: palette.textTertiary,
    },

    heroWrap: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 20,
      paddingBottom: 4,
    },
    heroEyebrow: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.1,
      color: palette.accent,
    },
    heroHeadline: {
      ...typeScale.headingLg,
      fontSize: 26,
      color: palette.textPrimary,
      marginTop: 6,
    },
    heroBody: {
      fontSize: 13,
      lineHeight: 19,
      color: palette.textSecondary,
      marginTop: 6,
      maxWidth: 320,
    },

    cards: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 16,
      paddingBottom: 16,
      gap: 12,
    },
    card: {
      position: 'relative',
      overflow: 'hidden',
      borderRadius: radii.xl,
      backgroundColor: palette.bgSurface,
      borderWidth: 1.5,
      borderColor: palette.borderSubtle,
      padding: 16,
    },
    cardTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    cardIcon: {
      width: 40,
      height: 40,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardTopRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    lastUsedPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radii.full,
      backgroundColor: palette.bgMuted,
    },
    lastUsedDot: {
      width: 5,
      height: 5,
      borderRadius: 999,
      backgroundColor: palette.success,
    },
    lastUsedText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
      color: palette.textSecondary,
    },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 999,
      borderWidth: 1.5,
      borderColor: palette.borderDefault,
      alignItems: 'center',
      justifyContent: 'center',
    },

    cardLabel: {
      fontSize: 22,
      fontWeight: '700',
      letterSpacing: -0.22,
      color: palette.textPrimary,
    },
    cardTagline: {
      fontSize: 13,
      color: palette.textSecondary,
      marginTop: 2,
    },

    orgRow: {
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: palette.borderSubtle,
      borderStyle: 'dashed',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    orgIcon: {
      width: 28,
      height: 28,
      borderRadius: radii.sm,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    orgName: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    orgRole: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 1,
    },

    cta: {
      height: 52,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaInner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    ctaText: {
      fontSize: 15,
      fontWeight: '600',
      color: '#fff',
    },
  });
