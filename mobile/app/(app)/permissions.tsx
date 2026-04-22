/**
 * Permissions — Otoqa Driver design system.
 *
 * Ports lib/permissions-screen.jsx: hero status summary, Required +
 * Optional grouped lists with expandable rows that reveal the "why"
 * copy, and a sticky bottom "Open device settings" button (the only
 * place permission state can actually change on iOS for most toggles).
 *
 * Uses live status from expo-location, expo-camera, expo-image-picker,
 * and expo-notifications so the summary reflects reality.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'expo-camera';
import * as Notifications from 'expo-notifications';
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

type PermKey = 'location' | 'camera' | 'notifications' | 'photos' | 'motion';

// For location we track three buckets matching the design spec so the
// "While using" warning can light up. Other permissions are binary.
type PermState = 'always' | 'while-using' | 'granted' | 'denied' | 'unknown';

interface PermItem {
  key: PermKey;
  icon: IconName;
  label: string;
  why: string;
  required: boolean;
  state: PermState;
}

const INITIAL_ITEMS: PermItem[] = [
  {
    key: 'location',
    icon: 'location',
    label: 'Location',
    why:
      'Tracks deliveries and route progress. Set to Always so we can log drop-offs while the app is in the background.',
    required: true,
    state: 'unknown',
  },
  {
    key: 'camera',
    icon: 'camera',
    label: 'Camera',
    why: 'Scan truck QR codes and capture proof-of-delivery photos.',
    required: true,
    state: 'unknown',
  },
  {
    key: 'notifications',
    icon: 'bell',
    label: 'Notifications',
    why:
      'New loads, detours, and dispatcher messages. Silenced during rest hours.',
    required: true,
    state: 'unknown',
  },
  {
    key: 'motion',
    icon: 'motion',
    label: 'Motion',
    why:
      'Improves arrival-detection accuracy at stops. Change this in the device Settings app.',
    required: false,
    state: 'unknown',
  },
  {
    key: 'photos',
    icon: 'clipboard',
    label: 'Photo library',
    why: 'Upload previously taken photos of receipts and documentation.',
    required: false,
    state: 'unknown',
  },
];

export default function PermissionsScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const [items, setItems] = useState<PermItem[]>(INITIAL_ITEMS);
  const [openKey, setOpenKey] = useState<PermKey | null>(null);

  const refresh = useCallback(async () => {
    const [fg, bg, cam, photos, notifs] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync().catch(() => null),
      Camera.getCameraPermissionsAsync(),
      ImagePicker.getMediaLibraryPermissionsAsync(),
      Notifications.getPermissionsAsync().catch(() => null),
    ]);

    const locationState: PermState = !fg.granted
      ? 'denied'
      : bg?.granted
        ? 'always'
        : 'while-using';
    const cameraState: PermState = cam.granted ? 'granted' : 'denied';
    const photoState: PermState = photos.granted ? 'granted' : 'denied';
    const notifState: PermState = notifs
      ? notifs.status === 'granted' ||
        (Platform.OS === 'ios' &&
          (notifs.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
            notifs.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL))
        ? 'granted'
        : 'denied'
      : 'unknown';

    setItems((prev) =>
      prev.map((it) => {
        if (it.key === 'location') return { ...it, state: locationState };
        if (it.key === 'camera') return { ...it, state: cameraState };
        if (it.key === 'notifications') return { ...it, state: notifState };
        if (it.key === 'photos') return { ...it, state: photoState };
        return it;
      }),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSettings = () => {
    if (Platform.OS === 'ios') void Linking.openURL('app-settings:');
    else void Linking.openSettings();
  };

  const routeToSettings = (reason: string) => {
    Alert.alert(
      'Open device settings',
      reason,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open settings', onPress: openSettings },
      ],
      { cancelable: true },
    );
  };

  const requestFor = async (key: PermKey) => {
    if (key === 'location') {
      // iOS only shows the foreground and background permission dialogs ONCE
      // each. If the user has already chosen "While Using", asking for
      // Always again returns the same value silently. Detect that and route
      // them to Settings, which is the only remaining path.
      const fgBefore = await Location.getForegroundPermissionsAsync();
      const fg = fgBefore.granted
        ? fgBefore
        : await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) {
        routeToSettings(
          'Location is currently off. Turn it on in Settings to start tracking deliveries.',
        );
        await refresh();
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync().catch(
        () => null,
      );
      if (!bg?.granted) {
        routeToSettings(
          Platform.OS === 'ios'
            ? 'To upgrade to Always, open Settings → Otoqa → Location and pick "Always".'
            : 'To upgrade to Always, open Settings → Apps → Otoqa → Permissions → Location and pick "Allow all the time".',
        );
      }
    } else if (key === 'camera') {
      const res = await Camera.requestCameraPermissionsAsync();
      if (!res.granted) {
        routeToSettings('Camera access is turned off. Enable it in Settings.');
      }
    } else if (key === 'photos') {
      const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!res.granted) {
        routeToSettings('Photo library access is turned off. Enable it in Settings.');
      }
    } else if (key === 'notifications') {
      // On iOS, the notifications prompt only shows once; after that we
      // must send the driver to Settings to flip it.
      const before = await Notifications.getPermissionsAsync().catch(() => null);
      const res = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      }).catch(() => null);
      const gotGranted =
        res?.status === 'granted' ||
        (Platform.OS === 'ios' &&
          (res?.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
            res?.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL));
      if (!gotGranted && before?.status !== 'undetermined') {
        routeToSettings('Notifications are off. Enable them in Settings.');
      }
    } else if (key === 'motion') {
      // No runtime prompt is wired for Motion yet — that requires
      // expo-sensors + NSMotionUsageDescription. Point the driver at
      // Settings instead, which always works.
      routeToSettings(
        'Motion permission is controlled in device Settings. Enable it under Settings → Otoqa → Motion & Fitness.',
      );
    }
    await refresh();
  };

  // ---- Summary ------------------------------------------------------------
  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, bad: 0, opt: 0 };
    for (const it of items) {
      const bucket = stateBucket(it);
      if (bucket === 'bad' && !it.required) c.opt++;
      else c[bucket as 'ok' | 'warn' | 'bad']++;
    }
    return c;
  }, [items]);

  const summary = summarize(counts, palette);
  const required = items.filter((i) => i.required);
  const optional = items.filter((i) => !i.required);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/(app)')
          }
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.topBarBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="arrow-left" size={22} color={palette.textPrimary} />
        </Pressable>
        <Text style={styles.topBarTitle}>Permissions</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 160 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero summary */}
        <View style={styles.heroWrap}>
          <Text style={styles.heroEyebrow}>Overall</Text>
          <Text style={[styles.heroHeadline, { color: summary.color }]}>
            {summary.headline}
          </Text>

          <View style={styles.bar}>
            {counts.ok > 0 && (
              <View style={{ flex: counts.ok, backgroundColor: palette.success }} />
            )}
            {counts.warn > 0 && (
              <View style={{ flex: counts.warn, backgroundColor: palette.warning }} />
            )}
            {counts.bad > 0 && (
              <View style={{ flex: counts.bad, backgroundColor: palette.danger }} />
            )}
            {counts.opt > 0 && (
              <View
                style={{
                  flex: counts.opt,
                  backgroundColor: palette.textTertiary,
                  opacity: 0.4,
                }}
              />
            )}
          </View>

          <View style={styles.legend}>
            {counts.ok > 0 && <Legend palette={palette} swatch={palette.success} label={`${counts.ok} on`} />}
            {counts.warn > 0 && (
              <Legend palette={palette} swatch={palette.warning} label={`${counts.warn} attention`} />
            )}
            {counts.bad > 0 && (
              <Legend palette={palette} swatch={palette.danger} label={`${counts.bad} off`} />
            )}
            {counts.opt > 0 && (
              <Legend
                palette={palette}
                swatch={palette.textTertiary}
                label={`${counts.opt} optional off`}
                dim
              />
            )}
          </View>
        </View>

        <PermGroup
          palette={palette}
          title="Required"
          items={required}
          openKey={openKey}
          setOpenKey={setOpenKey}
          onRequest={requestFor}
        />
        {optional.length > 0 && (
          <PermGroup
            palette={palette}
            title="Optional"
            items={optional}
            openKey={openKey}
            setOpenKey={setOpenKey}
            onRequest={requestFor}
          />
        )}
      </ScrollView>

      <View
        style={[
          styles.stickyWrap,
          // Sit the CTA in the thumb-reach band — mirrors how the driver
          // tab bar occupies the bottom. Safe-area inset covers the home
          // indicator; the extra 24 gives the button breathing room above
          // the device chrome so it doesn't feel pinned to the edge.
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Pressable
          onPress={openSettings}
          style={({ pressed }) => [styles.settingsBtn, pressed && { opacity: 0.9 }]}
        >
          <Icon name="settings" size={16} color={palette.textPrimary} />
          <Text style={styles.settingsBtnText}>Open device settings</Text>
          <Icon name="arrow-right" size={14} color={palette.textTertiary} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ============================================================================
// PIECES
// ============================================================================

const Legend: React.FC<{
  palette: Palette;
  swatch: string;
  label: string;
  dim?: boolean;
}> = ({ palette, swatch, label, dim }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, opacity: dim ? 0.7 : 1 }}>
    <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: swatch }} />
    <Text style={{ fontSize: 11, color: palette.textTertiary }}>{label}</Text>
  </View>
);

const PermGroup: React.FC<{
  palette: Palette;
  title: string;
  items: PermItem[];
  openKey: PermKey | null;
  setOpenKey: (k: PermKey | null) => void;
  onRequest: (k: PermKey) => void;
}> = ({ palette, title, items, openKey, setOpenKey, onRequest }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.groupWrap}>
      <Text style={styles.groupLabel}>{title.toUpperCase()}</Text>
      <View style={styles.groupCard}>
        {items.map((p, i) => (
          <View
            key={p.key}
            style={[
              i < items.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: palette.borderSubtle,
              },
            ]}
          >
            <PermRow
              palette={palette}
              perm={p}
              open={openKey === p.key}
              onToggle={() => setOpenKey(openKey === p.key ? null : p.key)}
              onRequest={() => onRequest(p.key)}
            />
          </View>
        ))}
      </View>
    </View>
  );
};

const PermRow: React.FC<{
  palette: Palette;
  perm: PermItem;
  open: boolean;
  onToggle: () => void;
  onRequest: () => void;
}> = ({ palette, perm, open, onToggle, onRequest }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const bucket = stateBucket(perm);
  const showWarn =
    bucket === 'warn' || (bucket === 'bad' && perm.required);
  // The action button is useful whenever the permission isn't already at
  // its optimal state — warn (while-using vs always) and bad (denied /
  // unknown) both benefit from a one-tap re-request. 'ok' hides it.
  const showCta = bucket !== 'ok';
  const warnTone =
    bucket === 'warn'
      ? { bg: 'rgba(245,158,11,0.14)', fg: palette.warning }
      : { bg: 'rgba(239,68,68,0.14)', fg: palette.danger };

  const stateLabel = (() => {
    if (perm.key === 'location') {
      if (perm.state === 'always') return 'Always';
      if (perm.state === 'while-using') return 'While using';
      return 'Off';
    }
    return perm.state === 'granted' ? 'On' : 'Off';
  })();

  const ctaLabel =
    perm.key === 'location' && perm.state === 'while-using'
      ? 'Change to Always'
      : 'Turn on';

  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
      >
        <View
          style={[
            styles.rowIcon,
            showWarn && { backgroundColor: warnTone.bg },
          ]}
        >
          <Icon
            name={perm.icon}
            size={16}
            color={showWarn ? warnTone.fg : palette.textSecondary}
          />
        </View>
        <Text style={styles.rowLabel}>{perm.label}</Text>
        <Text
          style={[
            styles.rowState,
            showWarn && { color: warnTone.fg },
          ]}
        >
          {stateLabel}
        </Text>
        <Icon
          name={open ? 'chevron-down' : 'chevron-down'}
          size={14}
          color={palette.textTertiary}
        />
      </Pressable>
      {open && (
        <View style={styles.rowExpand}>
          <Text style={styles.rowWhy}>{perm.why}</Text>
          {showCta && (
            <Pressable
              onPress={onRequest}
              style={({ pressed }) => [styles.rowAction, pressed && { opacity: 0.85 }]}
            >
              <Icon name="settings" size={12} color="#fff" />
              <Text style={styles.rowActionText}>{ctaLabel}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
};

// ============================================================================
// HELPERS
// ============================================================================

function stateBucket(p: PermItem): 'ok' | 'warn' | 'bad' {
  if (p.key === 'location') {
    if (p.state === 'always') return 'ok';
    if (p.state === 'while-using') return 'warn';
    return 'bad';
  }
  return p.state === 'granted' ? 'ok' : 'bad';
}

function summarize(
  counts: { ok: number; warn: number; bad: number; opt: number },
  palette: Palette,
): { headline: string; color: string } {
  if (counts.bad > 0) {
    return {
      headline: `${counts.bad} required ${counts.bad === 1 ? 'permission' : 'permissions'} off`,
      color: palette.danger,
    };
  }
  if (counts.warn > 0) {
    return {
      headline: `${counts.warn} ${counts.warn === 1 ? 'needs' : 'need'} attention`,
      color: palette.warning,
    };
  }
  return { headline: 'All set for driving', color: palette.success };
}

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    topBar: {
      height: 52,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topBarBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.full,
    },
    topBarTitle: {
      fontSize: 15,
      fontWeight: '600',
      letterSpacing: -0.15,
      color: palette.textPrimary,
    },

    heroWrap: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 4,
    },
    heroEyebrow: {
      fontSize: 13,
      color: palette.textTertiary,
    },
    heroHeadline: {
      fontSize: 22,
      fontWeight: '700',
      letterSpacing: -0.22,
      marginTop: 4,
    },
    bar: {
      flexDirection: 'row',
      gap: 3,
      height: 6,
      borderRadius: 999,
      marginTop: 12,
      overflow: 'hidden',
      backgroundColor: palette.bgMuted,
    },
    legend: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
      marginTop: 10,
    },

    groupWrap: {
      paddingHorizontal: sp.screenPx,
      paddingTop: sp.sectionGap,
    },
    groupLabel: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.8,
      color: palette.textTertiary,
      paddingHorizontal: 4,
      paddingBottom: 8,
    },
    groupCard: {
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
      paddingHorizontal: sp.listPx,
      paddingVertical: sp.listPy,
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
      fontWeight: '500',
      color: palette.textPrimary,
    },
    rowState: {
      fontSize: 12,
      fontWeight: '600',
      color: palette.textTertiary,
    },
    rowExpand: {
      paddingHorizontal: 14,
      paddingBottom: 14,
      paddingLeft: 54,
      gap: 10,
    },
    rowWhy: {
      fontSize: 12,
      lineHeight: 17,
      color: palette.textSecondary,
    },
    rowAction: {
      alignSelf: 'flex-start',
      height: 30,
      paddingHorizontal: 12,
      borderRadius: radii.sm,
      backgroundColor: palette.accent,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowActionText: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '600',
    },

    stickyWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: sp.screenPx,
      paddingTop: sp.screenPx,
      backgroundColor: palette.bgCanvas,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.borderSubtle,
    },
    settingsBtn: {
      height: 48,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.borderDefault,
      backgroundColor: palette.bgSurface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    settingsBtnText: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
  });
