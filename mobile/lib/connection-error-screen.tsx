/**
 * Connection / session error surfaces — React Native port of design bundle
 * v4's `lib/connection-error-screen.jsx`. The recovery counterpart to the
 * Ring loader in `otoqa-loader.tsx`, sharing the Orbit O mark.
 *
 * Three states, mapped to the network × WS-to-Convex × auth matrix that
 * `_layout.tsx` already computes:
 *
 *   reason   | network | WS/Convex     | auth  | screen
 *   ---------|---------|---------------|-------|-------------------------------
 *   offline  | offline | —             | —     | "You're Offline" — wait
 *   server   | online  | not connected | —     | "Can't reach our servers" — retry
 *   session  | online  | connected     | false | "Couldn't verify your session" → Sign out
 *
 * Design DNA: the Orbit O mark anchors all three, sat behind a static,
 * faded dashed ring (a signal that isn't getting through). Connectivity
 * errors carry an amber WARN badge and auto-retry on a visible countdown.
 * The session error is different — the link is fine, the server is up and
 * REJECTING us — so it wears a LOCK badge, drops the auto-retry, and makes
 * "Sign out" the primary action (retrying can't mint a fresh session).
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import type { Palette } from './design-tokens';
import { OrbitO } from './otoqa-loader';

export type ConnErrorReason = 'offline' | 'server' | 'session';

type Variant = {
  title: string;
  body: string;
  code: string;
  statusLabel: string;
  badge: 'warn' | 'lock';
  autoRetry: boolean;
  primary: { label: string; icon: keyof typeof Ionicons.glyphMap };
  secondary?: { label: string; icon: keyof typeof Ionicons.glyphMap; action: 'retry' | 'continue' };
};

const VARIANTS: Record<ConnErrorReason, Variant> = {
  offline: {
    title: "You're Offline",
    body: "No internet connection. We'll reconnect automatically the moment you're back online.",
    code: 'OTQ-NET-OFFLINE',
    statusLabel: 'Offline',
    badge: 'warn',
    autoRetry: true,
    primary: { label: 'Try again', icon: 'refresh' },
    // Don't strand the driver — let them proceed on cached data and sync on
    // reconnect (auto-retry keeps running in the background).
    secondary: { label: 'Continue offline', icon: 'arrow-forward', action: 'continue' },
  },
  server: {
    title: "Can't reach our servers",
    body: "You're online, but we can't reach Otoqa right now. Hang tight — we're retrying.",
    code: 'OTQ-NET-WS',
    statusLabel: 'Reconnecting',
    badge: 'warn',
    autoRetry: true,
    primary: { label: 'Retry now', icon: 'refresh' },
  },
  session: {
    title: "Couldn't verify your session",
    body: "You're connected, but we couldn't confirm your sign-in. Sign out and sign back in to continue.",
    code: 'OTQ-AUTH-401',
    statusLabel: 'Session not verified',
    badge: 'lock',
    autoRetry: false,
    primary: { label: 'Sign out', icon: 'log-out-outline' },
    secondary: { label: 'Try again', icon: 'refresh', action: 'retry' },
  },
};

// ── Badge glyphs ───────────────────────────────────────────
// Drawn as SVG paths (not a font <Ionicons>) so they render reliably in the
// same react-native-svg layer as the orbit — a nested font glyph in the
// badge wasn't painting on device.
function BadgeGlyph({
  kind,
  size,
  color,
  cutout,
}: {
  kind: 'warn' | 'lock';
  size: number;
  color: string;
  cutout: string;
}) {
  if (kind === 'warn') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M12 3.5 L21.8 20.5 H2.2 Z" fill={color} />
        <Rect x={10.9} y={9} width={2.2} height={6} rx={1.1} fill={cutout} />
        <Circle cx={12} cy={17.9} r={1.2} fill={cutout} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M7.5 11 V7.8 a4.5 4.5 0 0 1 9 0 V11"
        stroke={color}
        strokeWidth={2.1}
        fill="none"
        strokeLinecap="round"
      />
      <Rect x={4.8} y={10.6} width={14.4} height={10.2} rx={2.5} fill={color} />
      <Circle cx={12} cy={15.2} r={1.5} fill={cutout} />
    </Svg>
  );
}

// ── Error orbit mark ───────────────────────────────────────
// Per the design's landed ERROR_VARIANTS the orbit stays INTACT for all
// three states (so we reuse OrbitO); the badge is what changes — an amber
// warning for connectivity, a neutral lock for "reached but rejected". A
// static dashed ring sits behind it: the signal that isn't getting through.
function ConnMark({
  size,
  badge,
  palette,
}: {
  size: number;
  badge: 'warn' | 'lock';
  palette: Palette;
}) {
  const outer = size * 1.5;
  const badgeBg = badge === 'warn' ? 'rgba(245,158,11,0.16)' : palette.bgSubtle;
  const badgeColor = badge === 'warn' ? palette.warning : palette.textSecondary;
  const badgeSize = size * 0.34;

  return (
    <View style={{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }}>
      {/* Static faded outer ring */}
      <Svg width={outer} height={outer} style={StyleSheet.absoluteFill}>
        <Circle
          cx={outer / 2}
          cy={outer / 2}
          r={outer / 2 - 2}
          fill="none"
          stroke={palette.borderSubtle}
          strokeWidth={1.5}
          strokeDasharray={[5, 5]}
          opacity={0.7}
        />
      </Svg>

      {/* Intact orbit + status badge */}
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <OrbitO size={size} color={palette.textSecondary} surface={palette.bgCanvas} />
        <View
          style={{
            position: 'absolute',
            right: size * 0.02,
            bottom: size * 0.04,
            width: badgeSize,
            height: badgeSize,
            borderRadius: badgeSize / 2,
            backgroundColor: palette.bgCanvas,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <View
            style={{
              width: '84%',
              height: '84%',
              borderRadius: 999,
              backgroundColor: badgeBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BadgeGlyph kind={badge} size={size * 0.2} color={badgeColor} cutout={palette.bgCanvas} />
          </View>
        </View>
      </View>
    </View>
  );
}

// ── Action button (full-width, lg) ─────────────────────────
function ActionButton({
  label,
  icon,
  variant,
  spinning,
  onPress,
  palette,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  variant: 'primary' | 'secondary';
  spinning: boolean;
  onPress: () => void;
  palette: Palette;
}) {
  const isPrimary = variant === 'primary';
  const fg = isPrimary ? palette.textOnAction : palette.textPrimary;

  // Refresh icons spin once on tap; other icons stay put. useState lazy-init
  // keeps the Animated.Value stable without reading a ref during render.
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (spinning && icon === 'refresh') {
      spin.setValue(0);
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.bezier(0.2, 0, 0, 1),
        useNativeDriver: true,
      }).start();
    }
  }, [spinning, icon, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        isPrimary
          ? { backgroundColor: palette.accent }
          : { backgroundColor: 'transparent', borderWidth: 1, borderColor: palette.borderDefault },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Ionicons name={icon} size={19} color={fg} />
      </Animated.View>
      <Text style={[styles.btnLabel, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function ConnectionErrorScreen({
  reason = 'offline',
  autoRetrySeconds = 15,
  onRetry,
  onSignOut,
  onContinueOffline,
}: {
  reason?: ConnErrorReason;
  autoRetrySeconds?: number;
  /** `auto` distinguishes the countdown's automatic retries from taps —
   *  callers use it to keep manual_reauth telemetry honest. */
  onRetry?: (opts?: { auto?: boolean }) => void;
  onSignOut?: () => void;
  onContinueOffline?: () => void;
}) {
  const { palette } = useTheme();
  const v = VARIANTS[reason] ?? VARIANTS.offline;

  const [left, setLeft] = useState(autoRetrySeconds);
  const [spinning, setSpinning] = useState(false);
  // Keep the latest onRetry without re-arming the countdown each render.
  const onRetryRef = useRef(onRetry);
  useEffect(() => {
    onRetryRef.current = onRetry;
  }, [onRetry]);

  const triggerRetry = (auto = false) => {
    setSpinning(true);
    setLeft(autoRetrySeconds);
    setTimeout(() => setSpinning(false), 900);
    onRetryRef.current?.({ auto });
  };

  // Visible auto-retry countdown — connectivity states only. The remaining
  // count lives in a local variable so the retry fires from the interval
  // callback, not inside the setLeft updater (updaters must stay pure —
  // StrictMode double-invokes them, which double-fired the retry).
  useEffect(() => {
    if (!v.autoRetry) return;
    let remaining = autoRetrySeconds;
    setLeft(remaining);
    const id = setInterval(() => {
      if (remaining <= 1) {
        remaining = autoRetrySeconds;
        triggerRetry(true);
      } else {
        remaining -= 1;
        setLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRetrySeconds, reason]);

  // Breathing status dot — only while auto-retrying.
  const [breathe] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!v.autoRetry) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v.autoRetry, breathe]);
  const dotOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });

  const onPrimary = () => {
    if (reason === 'session') {
      onSignOut?.();
      return;
    }
    triggerRetry();
  };

  // Secondary routes by action: "Continue offline" proceeds on cached data;
  // otherwise it's a plain retry.
  const onSecondary = () => {
    if (v.secondary?.action === 'continue') {
      onContinueOffline?.();
      return;
    }
    triggerRetry();
  };

  const mins = Math.floor(left / 60);
  const secs = String(left % 60).padStart(2, '0');
  const s = makeStyles(palette);

  return (
    <View style={s.screen}>
      {/* Ambient neutral wash — nothing here is "live", so no accent. */}
      <View pointerEvents="none" style={s.ambient}>
        <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
          <Defs>
            <RadialGradient id="connWash" cx="50%" cy="34%" r="58%">
              <Stop offset="0%" stopColor={palette.bgMuted} stopOpacity={0.7} />
              <Stop offset="100%" stopColor={palette.bgMuted} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill="url(#connWash)" />
        </Svg>
      </View>

      {/* Hero — error mark */}
      <View style={s.hero}>
        <ConnMark size={108} badge={v.badge} palette={palette} />
      </View>

      {/* Message + actions */}
      <View style={s.body}>
        <Text style={s.title}>{v.title}</Text>
        <Text style={s.bodyText}>{v.body}</Text>

        <View style={s.actions}>
          <ActionButton
            label={v.primary.label}
            icon={v.primary.icon}
            variant="primary"
            spinning={spinning}
            onPress={onPrimary}
            palette={palette}
          />
          {v.secondary && (
            <ActionButton
              label={v.secondary.label}
              icon={v.secondary.icon}
              variant="secondary"
              spinning={spinning}
              onPress={onSecondary}
              palette={palette}
            />
          )}
        </View>

        {/* Status line */}
        <View style={s.statusRow}>
          <Animated.View
            style={[
              s.statusDot,
              { backgroundColor: v.badge === 'lock' ? palette.textTertiary : palette.warning },
              v.autoRetry && { opacity: dotOpacity },
            ]}
          />
          {v.autoRetry ? (
            spinning ? (
              <Text style={s.statusText}>Reconnecting…</Text>
            ) : (
              <Text style={s.statusText}>
                Retrying automatically in{' '}
                <Text style={s.statusCountdown}>
                  {mins}:{secs}
                </Text>
              </Text>
            )
          ) : (
            <Text style={s.statusText}>This won't fix itself by waiting</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: 56,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  btnLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
      overflow: 'hidden',
    },
    ambient: {
      ...StyleSheet.absoluteFillObject,
    },
    hero: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingBottom: 30,
    },
    body: {
      flex: 1,
      alignItems: 'center',
      paddingHorizontal: 32,
      paddingBottom: 48,
    },
    title: {
      fontSize: 23,
      lineHeight: 30,
      fontWeight: '700',
      letterSpacing: -0.23,
      textAlign: 'center',
      color: palette.textPrimary,
    },
    bodyText: {
      marginTop: 10,
      fontSize: 14.5,
      lineHeight: 21,
      color: palette.textSecondary,
      textAlign: 'center',
      maxWidth: 290,
    },
    actions: {
      width: '100%',
      maxWidth: 300,
      marginTop: 28,
      gap: 10,
    },
    statusRow: {
      marginTop: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 99,
    },
    statusText: {
      fontSize: 12.5,
      color: palette.textTertiary,
    },
    statusCountdown: {
      color: palette.textSecondary,
      fontVariant: ['tabular-nums'],
    },
  });

// ── Offline-mode indicator ─────────────────────────────────
// A small floating pill telling the driver they're on cached data after
// continuing offline (or losing connection mid-session). Fades/slides in
// and — crucially — animates away the moment connectivity returns. Drive
// `visible` from the real online state. pointerEvents none so it never
// intercepts touches on the app underneath.
export function OfflineIndicator({
  visible,
  status = 'offline',
  topOffset,
  align = 'left',
}: {
  visible: boolean;
  // Which connectivity state the pill reports. Both are degraded states on
  // the same warning-amber dot; only the label differs.
  status?: 'offline' | 'weak';
  topOffset?: number;
  // 'left' sits the pill over the header's greeting/name area (its opaque
  // surface covers that low-value text); 'center' floats it for screens
  // without a header to defer to.
  align?: 'left' | 'center';
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const top = topOffset ?? insets.top + 8;
  const isLeft = align === 'left';
  const label = status === 'weak' ? 'Weak signal · syncing' : 'Offline · saved data';

  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    // Fade IN on appear only. There is deliberately NO fade-OUT: when
    // `visible` flips false the pill unmounts immediately (guard below) so it
    // and its shadow vanish together. A fade-out would leave the Android
    // elevation shadow painted for the whole fade after the pill had visually
    // gone — which is exactly the lingering-shadow bug.
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1,
      duration: 320,
      easing: Easing.bezier(0.2, 0, 0, 1),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });

  // Unmount the instant we're hidden — pill and shadow leave together.
  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        alignItems: isLeft ? 'flex-start' : 'center',
        paddingHorizontal: isLeft ? 16 : 0,
        zIndex: 60,
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
      }}
    >
      <View style={indicatorStyles(palette).pill}>
        <View style={indicatorStyles(palette).dotRing}>
          <Animated.View style={[indicatorStyles(palette).dot, { opacity: dotOpacity }]} />
        </View>
        <Text style={indicatorStyles(palette).label}>{label}</Text>
      </View>
    </Animated.View>
  );
}

const indicatorStyles = (palette: Palette) =>
  StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingLeft: 11,
      paddingRight: 14,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: palette.bgSurfaceElevated,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 8,
      elevation: 6,
    },
    dotRing: {
      width: 13,
      height: 13,
      borderRadius: 999,
      backgroundColor: 'rgba(245,158,11,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    dot: {
      width: 7,
      height: 7,
      borderRadius: 999,
      backgroundColor: palette.warning,
    },
    label: {
      fontSize: 12.5,
      fontWeight: '600',
      color: palette.textSecondary,
    },
  });
