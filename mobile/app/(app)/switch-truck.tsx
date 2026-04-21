/**
 * Truck QR scanner — Otoqa Driver design system.
 *
 * Ports lib/scanner-screen.jsx: full-bleed camera preview with glass
 * controls, accent-cornered cutout, scanline animation, and a manual-code
 * bottom sheet with its own numeric keypad.
 *
 * Convex wiring (switchTruck mutation, profile query, post-scan routing
 * into /start-shift) is preserved verbatim from the previous version.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Svg, { Defs, Mask, Rect } from 'react-native-svg';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { useAppMode } from './_layout';
import { Icon } from '../../lib/design-icons';
import { useTheme } from '../../lib/ThemeContext';
import { radii, typeScale, type Palette } from '../../lib/design-tokens';

const CUTOUT = 260;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface QRCodeData {
  type: 'otoqa-truck';
  truckId: string;
  unitId: string;
}

interface ParsedQR {
  valid: boolean;
  data?: QRCodeData;
  error?: string;
}

function parseQRCode(raw: string): ParsedQR {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type !== 'otoqa-truck') return { valid: false, error: 'Invalid QR code type' };
    if (!parsed.truckId || typeof parsed.truckId !== 'string')
      return { valid: false, error: 'Missing truck ID' };
    if (!parsed.unitId || typeof parsed.unitId !== 'string')
      return { valid: false, error: 'Missing unit ID' };
    return { valid: true, data: parsed as QRCodeData };
  } catch {
    return { valid: false, error: 'Invalid QR code format' };
  }
}

export default function SwitchTruckScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [torch, setTorch] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);

  const { roles } = useAppMode();
  const profile = useQuery(api.driverMobile.getMyProfile, {
    driverId: (roles?.driverId ?? undefined) as Id<'drivers'> | undefined,
  });
  const switchTruck = useMutation(api.driverMobile.switchTruck);

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission]);

  // Scanline animation — travels from the top of the cutout to the bottom
  // and back. Drops to zero while a scan is being processed so it doesn't
  // compete with the success / error moment.
  const scanlineY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (scanned) {
      scanlineY.stopAnimation();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanlineY, {
          toValue: CUTOUT - 4,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scanlineY, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scanned, scanlineY]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    const parsed = parseQRCode(data);
    setScanned(true);
    if (!parsed.valid) {
      Alert.alert('Invalid QR code', parsed.error || 'Please scan a valid truck QR.', [
        { text: 'Try again', onPress: () => setScanned(false) },
      ]);
      return;
    }
    void confirmScan(parsed.data!);
  };

  const confirmScan = async (data: QRCodeData) => {
    if (!profile) {
      Alert.alert('Error', 'Driver profile not loaded. Please try again.');
      setScanned(false);
      return;
    }
    setIsSwitching(true);
    try {
      const result = await switchTruck({
        driverId: profile._id,
        truckId: data.truckId as Id<'trucks'>,
      });
      if (!result.success) {
        Alert.alert('Unable to switch', result.message, [
          { text: 'Try again', onPress: () => setScanned(false) },
        ]);
        return;
      }
      router.replace({
        pathname: '/start-shift',
        params: {
          truckId: data.truckId,
          truckUnitId: data.unitId,
          truckMake: profile.truck?.make ?? '',
          truckModel: profile.truck?.model ?? '',
        },
      });
    } catch (err) {
      console.error('Switch truck error:', err);
      Alert.alert('Error', 'Failed to switch truck. Please try again.', [
        { text: 'OK', onPress: () => setScanned(false) },
      ]);
    } finally {
      setIsSwitching(false);
    }
  };

  const handleManualSubmit = () => {
    // The manual code path would need a backend endpoint that resolves a
    // 6-digit code to a truckId. Until that lands, tell the driver to use
    // the scanner — same behaviour as before, but through the design's
    // sheet UX.
    Alert.alert(
      'Manual entry coming soon',
      'For now please scan the QR on your truck. Manual code entry will work once dispatch hands out printed codes.',
      [{ text: 'OK', onPress: () => setManualOpen(false) }],
    );
  };

  // ---- Permission gate ----------------------------------------------------
  if (!permission) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.loadingText}>Requesting camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.glassBtn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="arrow-left" size={20} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.center}>
          <View style={styles.permIcon}>
            <Icon name="search" size={28} color="#fff" />
          </View>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            We need your camera to scan the QR code on your truck&apos;s dash.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [styles.permCta, pressed && { opacity: 0.9 }]}
          >
            <Text style={styles.permCtaText}>Allow camera</Text>
          </Pressable>
          <Pressable onPress={() => setManualOpen(true)}>
            <Text style={styles.permLink}>Or enter code manually</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ---- Scanner ------------------------------------------------------------
  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      />

      {/* Dim mask with a cutout window */}
      <CutoutMask scanlineY={scanlineY} scanned={scanned} />

      {/* Top glass nav */}
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)'))}
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.glassBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="arrow-left" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.topTitle}>Scan truck QR</Text>
        <Pressable
          onPress={() => router.replace('/(app)')}
          accessibilityLabel="Skip"
          style={({ pressed }) => [styles.glassPill, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.glassPillText}>Skip</Text>
          <Icon name="chevron-right" size={16} color="#fff" />
        </Pressable>
      </View>

      {/* Helper text above cutout */}
      <View style={styles.helperWrap} pointerEvents="none">
        <Text style={styles.helperTitle}>Point at the QR on the dash</Text>
        <Text style={styles.helperBody}>
          Or tap <Text style={styles.helperStrong}>Enter code</Text> below to type it in
        </Text>
      </View>

      {/* Bottom controls */}
      <View style={[styles.bottomWrap, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.btnRow}>
          <Pressable
            onPress={() => setTorch((t) => !t)}
            accessibilityLabel="Torch"
            style={({ pressed }) => [
              styles.circleBtn,
              torch && styles.circleBtnActive,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Icon name={torch ? 'sun' : 'moon'} size={22} color={torch ? '#000' : '#fff'} />
          </Pressable>
          <Pressable
            onPress={() => setManualOpen(true)}
            accessibilityLabel="Enter code"
            style={({ pressed }) => [styles.wideBtn, pressed && { opacity: 0.8 }]}
          >
            <Icon name="menu" size={18} color="#fff" />
            <Text style={styles.wideBtnText}>Enter code</Text>
          </Pressable>
        </View>
        <Text style={styles.skipHint}>
          Not driving today?{' '}
          <Text style={styles.skipLink} onPress={() => router.replace('/(app)')}>
            Skip to dashboard
          </Text>
        </Text>
      </View>

      {isSwitching && (
        <View style={styles.processing} pointerEvents="auto">
          <Text style={styles.processingText}>Switching…</Text>
        </View>
      )}

      <ManualCodeSheet
        palette={palette}
        visible={manualOpen}
        code={manualCode}
        setCode={setManualCode}
        onClose={() => {
          setManualOpen(false);
          setManualCode('');
        }}
        onSubmit={handleManualSubmit}
      />
    </View>
  );
}

// ============================================================================
// CUTOUT — four corner brackets + moving scanline, over a dimmed backdrop
// ============================================================================

// Match the bracket's inner curve. Accent brackets draw a 3px stroke with
// borderRadius 16 on their outside corner, so the inside of the curve sits
// at roughly r = 16 - 3 = 13 and an exact match risks hairline bleed;
// 14 lands snug against the blue without a visible gap.
const CUTOUT_RADIUS = 14;

const CutoutMask: React.FC<{
  scanlineY: Animated.Value;
  scanned: boolean;
}> = ({ scanlineY, scanned }) => {
  const padH = (SCREEN_W - CUTOUT) / 2;
  const padV = (SCREEN_H - CUTOUT) / 2;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Full-screen dim with a rounded-rect hole cut out by an SVG mask.
          Replaces the earlier 4-pane tiling — those had sharp 90° corners
          that didn't meet the bracket radius, leaving visible gaps where
          the camera feed poked through between the bracket curve and the
          dim's corner. An SVG mask gives us exact matching radii. */}
      <Svg
        width={SCREEN_W}
        height={SCREEN_H}
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <Mask id="cutoutMask">
            {/* Everything white stays dim. The inner rect is black, which
                the mask treats as transparent — that's the window. */}
            <Rect x="0" y="0" width={SCREEN_W} height={SCREEN_H} fill="white" />
            <Rect
              x={padH}
              y={padV}
              width={CUTOUT}
              height={CUTOUT}
              rx={CUTOUT_RADIUS}
              ry={CUTOUT_RADIUS}
              fill="black"
            />
          </Mask>
        </Defs>
        <Rect
          x="0"
          y="0"
          width={SCREEN_W}
          height={SCREEN_H}
          fill="rgba(0,0,0,0.55)"
          mask="url(#cutoutMask)"
        />
      </Svg>

      {/* Corner brackets + scanline sit inside the window */}
      <View
        style={{
          position: 'absolute',
          left: padH,
          top: padV,
          width: CUTOUT,
          height: CUTOUT,
        }}
      >
        {/* top-left */}
        <View style={[scannerStyles.bracket, { top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 16 }]} />
        {/* top-right */}
        <View style={[scannerStyles.bracket, { top: -2, right: -2, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 16 }]} />
        {/* bottom-left */}
        <View style={[scannerStyles.bracket, { bottom: -2, left: -2, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 16 }]} />
        {/* bottom-right */}
        <View style={[scannerStyles.bracket, { bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 16 }]} />

        {!scanned && (
          <Animated.View
            style={[
              scannerStyles.scanline,
              { transform: [{ translateY: scanlineY }] },
            ]}
          />
        )}
      </View>
    </View>
  );
};

const scannerStyles = StyleSheet.create({
  bracket: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderColor: '#2E5CFF',
  },
  scanline: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 0,
    height: 2,
    backgroundColor: '#A5B6FF',
    shadowColor: '#2E5CFF',
    shadowOpacity: 0.8,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
});

// ============================================================================
// MANUAL CODE SHEET
// ============================================================================

const ManualCodeSheet: React.FC<{
  palette: Palette;
  visible: boolean;
  code: string;
  setCode: (c: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}> = ({ palette, visible, code, setCode, onClose, onSubmit }) => {
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const digits = code.padEnd(6, ' ').split('').slice(0, 6);

  const press = (k: string) => {
    if (k === '⌫') setCode(code.slice(0, -1));
    else if (code.length < 6) setCode(code + k);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.sheetOverlay}>
          <TouchableWithoutFeedback>
            <View style={styles.sheetBody}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Enter truck code</Text>
              <Text style={styles.sheetSubtitle}>
                6-digit code printed below the QR on the dash.
              </Text>

              <View style={styles.digitRow}>
                {digits.map((d, i) => {
                  const filled = d !== ' ';
                  return (
                    <View
                      key={i}
                      style={[styles.digitBox, filled && styles.digitBoxFilled]}
                    >
                      <Text style={styles.digitText}>{d.trim()}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={styles.keypad}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
                  <View key={i} style={styles.keyCell}>
                    {k ? (
                      <Pressable
                        onPress={() => press(k)}
                        style={({ pressed }) => [styles.key, pressed && { opacity: 0.8 }]}
                      >
                        <Text style={styles.keyText}>{k}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </View>

              {/* Hidden input so paste / autocomplete can still push 6 digits in */}
              <TextInput
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
              />

              <Pressable
                onPress={onSubmit}
                disabled={code.length < 6}
                style={({ pressed }) => [
                  styles.sheetCta,
                  code.length < 6 && { opacity: 0.4 },
                  pressed && code.length >= 6 && { opacity: 0.9 },
                ]}
              >
                <Text style={styles.sheetCtaText}>Connect to truck</Text>
              </Pressable>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: '#000',
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },

    // Top nav
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 5,
      paddingHorizontal: 12,
      paddingTop: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topTitle: {
      color: '#fff',
      fontSize: 17,
      fontWeight: '600',
      letterSpacing: -0.17,
    },
    glassBtn: {
      width: 40,
      height: 40,
      borderRadius: 999,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.22)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    glassPill: {
      height: 40,
      paddingHorizontal: 14,
      borderRadius: 999,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.22)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    glassPillText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '600',
    },

    // Helper text
    helperWrap: {
      position: 'absolute',
      top: '22%',
      left: 0,
      right: 0,
      alignItems: 'center',
      paddingHorizontal: 32,
      zIndex: 3,
    },
    helperTitle: {
      color: '#fff',
      fontSize: 17,
      fontWeight: '600',
      marginBottom: 6,
    },
    helperBody: {
      color: 'rgba(255,255,255,0.7)',
      fontSize: 14,
      lineHeight: 20,
      textAlign: 'center',
    },
    helperStrong: {
      color: '#fff',
      fontWeight: '600',
    },

    // Bottom controls
    bottomWrap: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 5,
      paddingHorizontal: 20,
      gap: 14,
      alignItems: 'center',
    },
    btnRow: {
      flexDirection: 'row',
      gap: 10,
      alignItems: 'center',
    },
    circleBtn: {
      width: 56,
      height: 56,
      borderRadius: 999,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.22)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    circleBtnActive: {
      backgroundColor: '#fff',
    },
    wideBtn: {
      height: 56,
      paddingHorizontal: 22,
      borderRadius: 999,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.22)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    wideBtnText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '600',
    },
    skipHint: {
      fontSize: 12,
      color: 'rgba(255,255,255,0.55)',
    },
    skipLink: {
      color: '#fff',
      fontWeight: '600',
      textDecorationLine: 'underline',
    },

    // Processing overlay
    processing: {
      position: 'absolute',
      inset: 0,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 20,
    },
    processingText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },

    // Permission gate
    loadingText: {
      color: '#fff',
      fontSize: 14,
    },
    permIcon: {
      width: 72,
      height: 72,
      borderRadius: 999,
      backgroundColor: 'rgba(255,255,255,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 20,
    },
    permTitle: {
      ...typeScale.headingMd,
      color: '#fff',
      textAlign: 'center',
    },
    permBody: {
      fontSize: 14,
      lineHeight: 20,
      color: 'rgba(255,255,255,0.7)',
      textAlign: 'center',
      maxWidth: 300,
      marginTop: 8,
    },
    permCta: {
      marginTop: 28,
      height: 52,
      paddingHorizontal: 24,
      borderRadius: radii.md,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    permCtaText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '600',
    },
    permLink: {
      marginTop: 14,
      color: '#fff',
      fontSize: 13,
      fontWeight: '500',
      textDecorationLine: 'underline',
    },

    // Sheet
    sheetOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheetBody: {
      backgroundColor: palette.bgSurface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 20,
      paddingBottom: 32,
      gap: 16,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.borderDefault,
    },
    sheetTitle: {
      ...typeScale.headingMd,
      color: palette.textPrimary,
    },
    sheetSubtitle: {
      fontSize: 13,
      lineHeight: 18,
      color: palette.textSecondary,
      marginTop: -6,
    },
    digitRow: {
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    digitBox: {
      flex: 1,
      aspectRatio: 1 / 1.1,
      maxWidth: 48,
      borderRadius: radii.md,
      borderWidth: 1.5,
      borderColor: palette.borderDefault,
      backgroundColor: palette.bgSurface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    digitBoxFilled: {
      borderColor: palette.accent,
    },
    digitText: {
      fontSize: 22,
      fontWeight: '600',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    keypad: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    keyCell: {
      width: '33.3333%',
      padding: 4,
    },
    key: {
      height: 48,
      borderRadius: radii.lg,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keyText: {
      fontSize: 20,
      fontWeight: '500',
      color: palette.textPrimary,
    },
    sheetCta: {
      height: 52,
      borderRadius: radii.md,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetCtaText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '600',
    },
  });
