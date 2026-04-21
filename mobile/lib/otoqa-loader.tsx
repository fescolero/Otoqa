/**
 * Otoqa loading surfaces — React Native port of design bundle v4's
 * Loading · Ring variant (lib/loading-screens.jsx → OtoqaRingLoader +
 * LoadingRingScreen).
 *
 * The Ring loader is the brand's "orbit in motion": the OrbitO mark
 * (outer orbit + solid core + traveling dot) sits inside a concentric
 * sweeping arc that rotates 360° on a 1.1s linear loop. An ambient
 * radial accent-tint wash behind the mark gives the screen body.
 *
 * Native considerations vs the web source:
 *   • CSS @keyframes → Animated.Value driven rotation (linear, native).
 *   • SVG linearGradient stroke is supported by react-native-svg.
 *   • `strokeDasharray` in RN accepts a number[]; we precompute.
 *   • LoadingDots pulse via a single Animated.Value with 3 offset
 *     interpolations — matches the 0.14s stagger in the design.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from './ThemeContext';
import type { Palette } from './design-tokens';

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

// ── Brand mark ─────────────────────────────────────────────
// Canonical Orbit O: outer orbit, solid core, one traveling dot. The
// dot punches a hole in the ring via a surface-colored circle and the
// filled accent dot sits inside that hole, so it reads correctly on
// any background as long as `surface` matches.
type OrbitOProps = {
  size?: number;
  color?: string;
  surface?: string;
};

export function OrbitO({ size = 32, color, surface }: OrbitOProps) {
  const { palette } = useTheme();
  const stroke = color ?? palette.accent;
  const bg = surface ?? palette.bgCanvas;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx={50} cy={50} r={32} stroke={stroke} strokeWidth={8} fill="none" />
      <Circle cx={50} cy={50} r={12} fill={stroke} />
      <Circle cx={76} cy={32} r={10} fill={bg} />
      <Circle cx={76} cy={32} r={6} fill={stroke} />
    </Svg>
  );
}

// ── Ring loader (14d in the design) ────────────────────────
// Concentric sweeping arc around the mark. The arc uses a horizontal
// linearGradient (0 → 1 alpha) so its leading edge fades in, giving
// the illusion of the orbit chasing its tail. We rotate the whole
// svg 360° rather than animating stroke-dashoffset, matching the
// design's simpler approach.
type OtoqaRingLoaderProps = {
  size?: number;
};

export function OtoqaRingLoader({ size = 80 }: OtoqaRingLoaderProps) {
  const { palette } = useTheme();
  const trackW = Math.max(2, size * 0.06);

  const rotate = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotate]);

  const spin = rotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Arc length: 28% of the circumference, dashed against the full
  // circumference for the remainder.
  const circumference = Math.PI * 2 * 46;
  const dash = circumference * 0.28;
  const gap = circumference;

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AnimatedSvg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        style={[StyleSheet.absoluteFill, { transform: [{ rotate: spin }] }]}
      >
        <Defs>
          {/* Leading-edge fade: alpha ramps from 0 → 1 across the sweep */}
          <LinearGradient id="otoqaArc" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0%" stopColor={palette.accent} stopOpacity={0} />
            <Stop offset="100%" stopColor={palette.accent} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Circle
          cx={50}
          cy={50}
          r={46}
          fill="none"
          stroke={palette.borderSubtle}
          strokeWidth={trackW}
        />
        <Circle
          cx={50}
          cy={50}
          r={46}
          fill="none"
          stroke="url(#otoqaArc)"
          strokeWidth={trackW}
          strokeLinecap="round"
          strokeDasharray={[dash, gap]}
          transform="rotate(-90 50 50)"
        />
      </AnimatedSvg>
      <OrbitO size={size * 0.7} color={palette.accent} surface={palette.bgCanvas} />
    </View>
  );
}

// ── Loading dots (3-dot pulse) ─────────────────────────────
// Matches the design's `loadingDot` @keyframes: each dot cycles
// opacity 0.3 → 1 → 0.3 with a 0.14s stagger across the trio.
type LoadingDotsProps = {
  color?: string;
  size?: number;
};

export function LoadingDots({ color, size = 4 }: LoadingDotsProps) {
  const { palette } = useTheme();
  const fill = color ?? palette.accent;
  // Three independent values started on a stagger — matches the design's
  // per-dot @keyframes with different animation-delays.
  const vals = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 140),
          Animated.timing(v, {
            toValue: 1,
            duration: 1100,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals]);

  return (
    <View style={styles.dotsRow}>
      {vals.map((v, i) => {
        const opacity = v.interpolate({
          inputRange: [0, 0.4, 0.8, 1],
          outputRange: [0.3, 1, 0.3, 0.3],
        });
        const scale = v.interpolate({
          inputRange: [0, 0.4, 0.8, 1],
          outputRange: [0.7, 1, 0.7, 0.7],
        });
        return (
          <Animated.View
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: size,
              backgroundColor: fill,
              opacity,
              transform: [{ scale }],
            }}
          />
        );
      })}
    </View>
  );
}

// ── Full-screen ring loading surface ──────────────────────
// Used by _layout.tsx gates as the default "we're working" surface.
// The ambient wash is a pseudo radial-gradient: a single centered
// accent-tint disc behind the mark. RN has no radial-gradient
// primitive, so we approximate with an SVG radial gradient scoped
// to the backdrop only.
type LoadingRingScreenProps = {
  statusText?: string;
  subText?: string;
  style?: ViewStyle;
};

export function LoadingRingScreen({
  statusText = 'Loading…',
  subText = 'Hang tight',
  style,
}: LoadingRingScreenProps) {
  const { palette } = useTheme();
  const s = useMemo(() => makeStyles(palette), [palette]);

  return (
    <View style={[s.screen, style]}>
      {/* Ambient accent-tint wash — approximates the design's
          radial-gradient(circle at 50% 50%, accent-tint 0%, transparent 50%) */}
      <View pointerEvents="none" style={s.ambient}>
        <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
          <Defs>
            <RadialGradient id="ambientWash" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
              <Stop offset="0%" stopColor={palette.accentTint} stopOpacity={1} />
              <Stop offset="100%" stopColor={palette.accentTint} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill="url(#ambientWash)" />
        </Svg>
      </View>

      <View style={s.center}>
        <OtoqaRingLoader size={88} />
        <View style={s.textWrap}>
          <Text style={s.status}>{statusText}</Text>
          <View style={s.subRow}>
            <LoadingDots />
            <Text style={s.sub}>{subText}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
});

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      overflow: 'hidden',
    },
    ambient: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
    center: {
      alignItems: 'center',
      gap: 22,
    },
    textWrap: {
      alignItems: 'center',
    },
    status: {
      fontSize: 16,
      fontWeight: '600',
      letterSpacing: -0.08,
      color: palette.textPrimary,
      textAlign: 'center',
    },
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 6,
    },
    sub: {
      fontSize: 12,
      color: palette.textTertiary,
    },
  });
