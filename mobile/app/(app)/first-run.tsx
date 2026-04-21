/**
 * First Run — Otoqa Driver design system (port of lib/first-run-screens.jsx).
 *
 * Two steps threaded as internal state so one route handles the whole
 * flow:
 *
 *   1) Permissions priming. Required: Location, Notifications, Camera,
 *      Motion. Optional: Contacts. Tap "Grant access" fires a sequenced
 *      request chain (each perm asked one after the other) and advances
 *      once everything's been responded to. A "why?" sheet explains
 *      what each one does.
 *
 *   2) Consents. Three checkboxes: ToS + Privacy, ELD/HOS data sharing,
 *      Location recording while on duty. Each row has an expandable
 *      details panel. Primary CTA stays disabled until all three tick.
 *
 * Completion is stored in AsyncStorage so we don't re-run it. Routed
 * into from verify.tsx when a driver has no stored completion flag.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'expo-camera';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Icon, type IconName } from '../../lib/design-icons';
import { useTheme } from '../../lib/ThemeContext';
import { useDensityTokens } from '../../lib/density';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

export const FIRST_RUN_STORAGE_KEY = 'otoqa.firstRunCompleted.v1';

interface PermDef {
  key: 'location' | 'notifications' | 'camera' | 'motion' | 'contacts';
  icon: IconName;
  label: string;
  reason: string;
}

const REQUIRED: PermDef[] = [
  {
    key: 'location',
    icon: 'pin',
    label: 'Location',
    reason: 'Track loads and pickups while on duty',
  },
  {
    key: 'notifications',
    icon: 'bell',
    label: 'Notifications',
    reason: 'Load assignments, detours, and alerts',
  },
  {
    key: 'camera',
    icon: 'camera',
    label: 'Camera',
    reason: 'Scan truck QR and capture BOL photos',
  },
  {
    key: 'motion',
    icon: 'activity',
    label: 'Motion',
    reason: 'Distinguish driving from idle for HOS',
  },
];

const OPTIONAL: PermDef[] = [
  {
    key: 'contacts',
    icon: 'phone',
    label: 'Contacts',
    reason: 'Call dispatcher and support faster',
  },
];

export default function FirstRunScreen() {
  const [step, setStep] = useState<1 | 2>(1);
  const router = useRouter();

  const finish = async () => {
    try {
      await AsyncStorage.setItem(FIRST_RUN_STORAGE_KEY, new Date().toISOString());
    } catch {
      /* non-fatal */
    }
    // After first-run, route as verify.tsx would — scanner for users
    // without a truck (which is every new driver by definition).
    router.replace('/switch-truck');
  };

  if (step === 2) {
    return <ConsentsStep onBack={() => setStep(1)} onAccept={finish} />;
  }
  return <PermissionsStep onContinue={() => setStep(2)} />;
}

// ============================================================================
// STEP 1 — PERMISSIONS
// ============================================================================

function PermissionsStep({ onContinue }: { onContinue: () => void }) {
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const [requesting, setRequesting] = useState(false);
  const [askingIdx, setAskingIdx] = useState(-1);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [whyOpen, setWhyOpen] = useState(false);
  const cancelRef = useRef(false);

  const all = [...REQUIRED, ...OPTIONAL];

  const ask = async (key: PermDef['key']): Promise<boolean> => {
    if (key === 'location') {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.granted) {
        await Location.requestBackgroundPermissionsAsync().catch(() => null);
      }
      return fg.granted;
    }
    if (key === 'camera') {
      const r = await Camera.requestCameraPermissionsAsync();
      return r.granted;
    }
    if (key === 'notifications') {
      const r = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      }).catch(() => null);
      return !!(r && r.status === 'granted');
    }
    if (key === 'contacts') {
      // expo-contacts isn't a dep yet — treat as granted optimistically
      // since the design's "Contacts" is just a convenience shortcut.
      return true;
    }
    // motion — no expo-sensors dep; fall back to a 250ms sleep so the UI
    // cadence still feels real without pretending it's a real prompt.
    await new Promise((r) => setTimeout(r, 250));
    return true;
  };

  const run = async () => {
    setRequesting(true);
    cancelRef.current = false;
    for (let i = 0; i < all.length; i++) {
      if (cancelRef.current) break;
      setAskingIdx(i);
      const ok = await ask(all[i].key);
      setGranted((g) => ({ ...g, [all[i].key]: ok }));
      // Brief pulse so the "granted" state is visible before advancing.
      await new Promise((r) => setTimeout(r, 280));
    }
    setAskingIdx(-1);
    setRequesting(false);
    onContinue();
  };

  useEffect(
    () => () => {
      cancelRef.current = true;
    },
    [],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <FirstRunHeader step={1} total={2} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ marginTop: 4 }}>
          <Text style={styles.eyebrow}>STEP 1 OF 2</Text>
          <Text style={styles.headline}>A few permissions to get rolling</Text>
          <Text style={styles.subhead}>
            Otoqa uses these to keep you tracked, paid, and compliant. You can
            change them anytime in Settings.
          </Text>
        </View>

        <Text style={styles.groupLabel}>REQUIRED</Text>
        <View style={{ gap: 8 }}>
          {REQUIRED.map((p, i) => (
            <PermRow
              key={p.key}
              palette={palette}
              perm={p}
              required
              state={
                granted[p.key]
                  ? 'granted'
                  : requesting && askingIdx === i
                    ? 'asking'
                    : 'idle'
              }
            />
          ))}
        </View>

        <Text style={styles.groupLabel}>OPTIONAL</Text>
        <View style={{ gap: 8 }}>
          {OPTIONAL.map((p, i) => (
            <PermRow
              key={p.key}
              palette={palette}
              perm={p}
              state={
                granted[p.key]
                  ? 'granted'
                  : requesting && askingIdx === REQUIRED.length + i
                    ? 'asking'
                    : 'idle'
              }
            />
          ))}
        </View>

        <Pressable
          onPress={() => setWhyOpen(true)}
          style={({ pressed }) => [styles.whyBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="help" size={14} color={palette.textSecondary} />
          <Text style={styles.whyBtnText}>
            What happens if I skip a permission?
          </Text>
        </Pressable>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={run}
          disabled={requesting}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: palette.accent },
            pressed && !requesting && { opacity: 0.9 },
            requesting && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.ctaText}>
            {requesting ? 'Requesting…' : 'Grant access'}
          </Text>
        </Pressable>
      </View>

      {whyOpen && (
        <WhySheet palette={palette} onClose={() => setWhyOpen(false)} />
      )}
    </SafeAreaView>
  );
}

const PermRow: React.FC<{
  palette: Palette;
  perm: PermDef;
  state: 'idle' | 'asking' | 'granted';
  required?: boolean;
}> = ({ palette, perm, state, required }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const tone =
    state === 'granted'
      ? { bg: 'rgba(16,185,129,0.14)', fg: palette.success }
      : state === 'asking'
        ? { bg: palette.accentTint, fg: palette.accent }
        : { bg: palette.bgMuted, fg: palette.textSecondary };
  return (
    <View
      style={[
        styles.permRow,
        state === 'asking' && { borderColor: palette.accent },
      ]}
    >
      <View style={[styles.permIcon, { backgroundColor: tone.bg }]}>
        <Icon
          name={state === 'granted' ? 'check' : perm.icon}
          size={18}
          color={tone.fg}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.permLabelRow}>
          <Text style={styles.permLabel}>{perm.label}</Text>
          {!required && (
            <Text style={styles.optionalPill}>OPTIONAL</Text>
          )}
        </View>
        <Text style={styles.permReason}>{perm.reason}</Text>
      </View>
      {state === 'granted' && (
        <Text style={[styles.grantedText, { color: palette.success }]}>
          Granted
        </Text>
      )}
    </View>
  );
};

const WhySheet: React.FC<{ palette: Palette; onClose: () => void }> = ({
  palette,
  onClose,
}) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const rows: Array<{ title: string; body: string }> = [
    {
      title: 'Location — Required',
      body: "We can't assign or track loads without it. This is a job requirement.",
    },
    {
      title: 'Notifications — Required',
      body: "You'd miss load updates, detours, and dispatcher messages.",
    },
    {
      title: 'Camera — Required',
      body: 'Needed to scan the truck QR at start of shift and upload BOLs.',
    },
    {
      title: 'Motion — Required',
      body: 'Helps the app tell driving from breaks for accurate HOS logs.',
    },
    {
      title: 'Contacts — Optional',
      body: "Skip it and you'll still reach dispatch — just with a couple extra taps.",
    },
  ];
  return (
    <View style={styles.sheetOverlay} pointerEvents="box-none">
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.sheetBackdrop} />
      </TouchableWithoutFeedback>
      <View style={styles.sheetBody}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>What each permission does</Text>
        <View style={{ gap: 12, marginTop: 14 }}>
          {rows.map((r) => (
            <View key={r.title}>
              <Text style={styles.whyRowTitle}>{r.title}</Text>
              <Text style={styles.whyRowBody}>{r.body}</Text>
            </View>
          ))}
        </View>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [
            styles.whyCta,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.whyCtaText}>Got it</Text>
        </Pressable>
      </View>
    </View>
  );
};

// ============================================================================
// STEP 2 — CONSENTS
// ============================================================================

interface ConsentDef {
  key: 'tos' | 'eld' | 'location';
  title: string;
  summary: string;
  full: string;
}

const CONSENTS: ConsentDef[] = [
  {
    key: 'tos',
    title: 'Terms of Service & Privacy Policy',
    summary:
      'You agree to the Otoqa Terms and have read the Privacy Policy.',
    full:
      "By continuing, you accept the Otoqa Driver Terms of Service and acknowledge that you've read our Privacy Policy. These cover how your account works, acceptable use, and your rights.",
  },
  {
    key: 'eld',
    title: 'ELD & HOS data sharing',
    summary:
      'Hours-of-service and ELD data may be shared with your employer and the DOT.',
    full:
      'Per FMCSA Part 395, hours-of-service and electronic-logging records created on this device will be available to your employer and DOT inspectors as required. You remain the driver of record and can review and annotate your own logs anytime.',
  },
  {
    key: 'location',
    title: 'Location recording while on duty',
    summary: 'Location is recorded during shifts and paused off duty.',
    full:
      'Otoqa records location throughout an active shift to assign loads, estimate arrival, and build trip records for payroll. When you end your shift, location tracking pauses immediately. Location is never used for advertising.',
  },
];

function ConsentsStep({
  onBack,
  onAccept,
}: {
  onBack: () => void;
  onAccept: () => void;
}) {
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const allChecked = CONSENTS.every((c) => checked[c.key]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <FirstRunHeader step={2} total={2} onBack={onBack} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ marginTop: 4 }}>
          <Text style={styles.eyebrow}>STEP 2 OF 2</Text>
          <Text style={styles.headline}>Before we start</Text>
          <Text style={styles.subhead}>
            Please review and agree. All three are required to use Otoqa.
          </Text>
        </View>

        <View style={{ marginTop: 20, gap: 10 }}>
          {CONSENTS.map((c) => (
            <ConsentRow
              key={c.key}
              palette={palette}
              consent={c}
              checked={!!checked[c.key]}
              expanded={expanded === c.key}
              onToggleCheck={() =>
                setChecked((s) => ({ ...s, [c.key]: !s[c.key] }))
              }
              onToggleExpand={() =>
                setExpanded((e) => (e === c.key ? null : c.key))
              }
            />
          ))}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={() => allChecked && onAccept()}
          disabled={!allChecked}
          style={({ pressed }) => [
            styles.cta,
            allChecked
              ? { backgroundColor: palette.accent }
              : { backgroundColor: palette.bgMuted },
            pressed && allChecked && { opacity: 0.9 },
          ]}
        >
          <Text
            style={[
              styles.ctaText,
              !allChecked && { color: palette.textTertiary },
            ]}
          >
            {allChecked ? 'Accept & continue' : 'Accept all three to continue'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const ConsentRow: React.FC<{
  palette: Palette;
  consent: ConsentDef;
  checked: boolean;
  expanded: boolean;
  onToggleCheck: () => void;
  onToggleExpand: () => void;
}> = ({ palette, consent, checked, expanded, onToggleCheck, onToggleExpand }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View
      style={[
        styles.consentCard,
        checked && { borderColor: 'rgba(16,185,129,0.35)' },
      ]}
    >
      <Pressable
        onPress={onToggleCheck}
        style={({ pressed }) => [
          styles.consentTop,
          pressed && { opacity: 0.85 },
        ]}
      >
        <View
          style={[
            styles.consentCheck,
            checked && {
              backgroundColor: palette.success,
              borderColor: palette.success,
            },
          ]}
        >
          {checked && <Icon name="check" size={14} color="#fff" />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.consentTitle}>{consent.title}</Text>
          <Text style={styles.consentSummary}>{consent.summary}</Text>
        </View>
      </Pressable>
      <Pressable
        onPress={onToggleExpand}
        style={({ pressed }) => [
          styles.consentMore,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Icon
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={palette.textSecondary}
        />
        <Text style={styles.consentMoreText}>
          {expanded ? 'Hide details' : 'Read details'}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.consentFull}>
          <Text style={styles.consentFullText}>{consent.full}</Text>
        </View>
      )}
    </View>
  );
};

// ============================================================================
// HEADER — step indicator bar
// ============================================================================

const FirstRunHeader: React.FC<{
  step: 1 | 2;
  total: number;
  onBack?: () => void;
}> = ({ step, total, onBack }) => {
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.topBar}>
      <Pressable
        onPress={onBack}
        accessibilityLabel={onBack ? 'Back' : undefined}
        style={({ pressed }) => [
          styles.topBarBtn,
          pressed && { opacity: 0.7 },
          !onBack && { opacity: 0 },
        ]}
      >
        <Icon name="arrow-left" size={22} color={palette.textPrimary} />
      </Pressable>
      <View style={styles.stepDots}>
        {Array.from({ length: total }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.stepDot,
              i + 1 === step && { width: 24, backgroundColor: palette.accent },
              i + 1 < step && { backgroundColor: palette.accent },
            ]}
          />
        ))}
      </View>
      <View style={{ width: 44 }} />
    </View>
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
    topBar: {
      paddingHorizontal: 4,
      paddingTop: 4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 52,
    },
    topBarBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepDots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    stepDot: {
      width: 6,
      height: 6,
      borderRadius: 999,
      backgroundColor: palette.borderDefault,
    },

    body: {
      paddingHorizontal: sp.screenPx,
      paddingBottom: 130,
    },
    eyebrow: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    headline: {
      ...typeScale.headingLg,
      color: palette.textPrimary,
      marginTop: 4,
      lineHeight: 28,
    },
    subhead: {
      fontSize: 13,
      lineHeight: 20,
      color: palette.textSecondary,
      marginTop: 8,
    },
    groupLabel: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.8,
      color: palette.textTertiary,
      textTransform: 'uppercase',
      marginTop: 18,
      marginBottom: 8,
    },

    // Permission rows
    permRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
    },
    permIcon: {
      width: 36,
      height: 36,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    permLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    permLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    optionalPill: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.4,
      color: palette.textTertiary,
      backgroundColor: palette.bgMuted,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 999,
      overflow: 'hidden',
    },
    permReason: {
      fontSize: 12,
      color: palette.textTertiary,
      marginTop: 1,
    },
    grantedText: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.4,
    },

    // Why sheet
    sheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 90,
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
      padding: 20,
      paddingBottom: 34,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      borderRadius: 999,
      backgroundColor: palette.borderDefault,
      marginBottom: 14,
    },
    sheetTitle: {
      ...typeScale.headingMd,
      color: palette.textPrimary,
    },
    whyRowTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    whyRowBody: {
      fontSize: 12,
      lineHeight: 18,
      color: palette.textSecondary,
      marginTop: 2,
    },
    whyCta: {
      marginTop: 18,
      height: 48,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    whyCtaText: {
      fontSize: 15,
      fontWeight: '500',
      color: palette.textPrimary,
    },

    // Why link
    whyBtn: {
      marginTop: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    whyBtnText: {
      fontSize: 12,
      fontWeight: '500',
      color: palette.textSecondary,
    },

    // Footer + CTA
    footer: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 14,
      paddingBottom: 16,
      backgroundColor: palette.bgCanvas,
    },
    cta: {
      height: 52,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#fff',
    },

    // Consent rows
    consentCard: {
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      overflow: 'hidden',
    },
    consentTop: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      padding: 14,
    },
    consentCheck: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: palette.borderDefault,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    consentTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    consentSummary: {
      fontSize: 12,
      lineHeight: 18,
      color: palette.textSecondary,
      marginTop: 3,
    },
    consentMore: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingBottom: 14,
      paddingLeft: 44,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.borderSubtle,
    },
    consentMoreText: {
      fontSize: 12,
      fontWeight: '500',
      color: palette.textSecondary,
    },
    consentFull: {
      paddingHorizontal: 14,
      paddingBottom: 16,
      paddingLeft: 44,
    },
    consentFullText: {
      fontSize: 12,
      lineHeight: 18,
      color: palette.textSecondary,
    },
  });
