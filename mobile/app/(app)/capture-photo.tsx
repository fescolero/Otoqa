import { useState, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { trackPhotoCapture, trackPhotoSaved, trackPhotoSaveFailed, trackScreen } from '../../lib/analytics';

// Key for storing captured photo URI temporarily
const CAPTURED_PHOTO_KEY = 'captured_photo_uri';

// ============================================
// DESIGN SYSTEM
// ============================================
const colors = {
  background: '#1a1d21',
  foreground: '#f3f4f6',
  foregroundMuted: '#9ca3af',
  primary: '#ff6b00',
  primaryForeground: '#1a1d21',
  muted: '#2d323b',
  card: '#22262b',
  border: '#3f4552',
};

const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
};

const borderRadius = {
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
};

// ============================================
// CAPTURE PHOTO SCREEN
// ============================================
export default function CapturePhotoScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { loadId, locationName, stopSequence } = useLocalSearchParams<{
    loadId?: string;
    locationName?: string;
    stopSequence?: string;
  }>();

  const isFocused = useIsFocused();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [flashMode, setFlashMode] = useState<'off' | 'on'>('off');
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // Request camera permission
  if (!permission) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.permissionContainer, { paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Ionicons name="camera-outline" size={64} color={colors.foregroundMuted} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionText}>
          We need camera access to capture proof of delivery photos.
        </Text>
        <Pressable style={({ pressed }) => [styles.permissionButton, pressed && { opacity: 0.7 }]} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </Pressable>
        <Pressable 
          style={({ pressed }) => [styles.backButtonAlt, pressed && { opacity: 0.7 }]}
          onPress={() => {
            if (loadId) {
              router.replace(`/trip/${loadId}`);
            } else if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/(app)');
            }
          }}
        >
          <Text style={styles.backButtonAltText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  // Toggle camera facing
  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  // Toggle flash
  const toggleFlash = () => {
    setFlashMode(current => (current === 'off' ? 'on' : 'off'));
  };

  // Capture photo
  const capturePhoto = async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        skipProcessing: false,
        base64: false,
      });

      if (photo?.uri) {
        const uri = photo.uri.startsWith('file://') ? photo.uri : `file://${photo.uri}`;
        setCapturedPhoto(uri);
        trackPhotoCapture(true, loadId);
      } else {
        trackPhotoCapture(false, loadId, 'No image data received');
        Alert.alert(
          "Couldn't capture photo",
          'The camera returned no image. Tap the shutter again.',
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      trackPhotoCapture(false, loadId, msg);
      console.error('[CapturePhoto] Error capturing photo:', error);
      Alert.alert(
        "Couldn't capture photo",
        `${msg}\n\nTry again, or restart the app if this keeps happening.`,
      );
    } finally {
      setIsCapturing(false);
    }
  };

  // Retake photo
  const retakePhoto = () => {
    setCapturedPhoto(null);
  };

  // Use captured photo
  const usePhoto = async () => {
    if (!capturedPhoto) return;
    
    try {
      await AsyncStorage.setItem(CAPTURED_PHOTO_KEY, capturedPhoto);
      trackPhotoSaved(loadId);
      
      if (loadId) {
        router.replace(`/trip/${loadId}`);
      } else if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/(app)');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      trackPhotoSaveFailed(loadId, msg);
      console.error('[CapturePhoto] Failed to save photo:', error);
      Alert.alert(
        "Couldn't save photo",
        `${msg}\n\nTry tapping Use again.`,
      );
    }
  };

  // If we have a captured photo, show the preview
  if (capturedPhoto) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.container, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          {/* Header */}
          <View style={styles.header}>
            <Pressable style={({ pressed }) => [styles.headerBackButton, pressed && { opacity: 0.7 }]} onPress={retakePhoto}>
              <Ionicons name="arrow-back" size={24} color={colors.foreground} />
            </Pressable>
            <Text style={styles.headerTitle}>Review Photo</Text>
            <View style={styles.headerSpacer} />
          </View>

          {/* Photo Preview — flex:1 fills space between header and buttons */}
          <View style={styles.previewContainer} pointerEvents="none">
            <Image 
              source={{ uri: capturedPhoto }} 
              style={styles.previewImage}
              resizeMode="contain"
              onError={(e) => console.error('[CapturePhoto] Image load error:', e.nativeEvent.error)}
              onLoad={() => console.log('[CapturePhoto] Image loaded successfully')}
            />
          </View>

          <View style={styles.previewActions}>
            <Pressable
              style={({ pressed }) => [styles.retakeButton, pressed && { opacity: 0.7 }]}
              onPress={retakePhoto}
            >
              <Ionicons name="refresh" size={24} color={colors.foreground} />
              <Text style={styles.retakeButtonText}>Retake</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.usePhotoButton, pressed && { opacity: 0.7 }]}
              onPress={usePhoto}
            >
              <Ionicons name="checkmark" size={24} color={colors.primaryForeground} />
              <Text style={styles.usePhotoButtonText}>Use Photo</Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {/* Camera fills the entire screen behind everything.
            Only rendered when screen is focused so the session stops on navigate-away. */}
        {isFocused && (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flashMode}
          />
        )}

        {/* All controls in a normal flex column — no absolute positioning.
            This avoids overflow:hidden clipping from the Tabs navigator. */}
        <View style={[styles.controlsColumn, { paddingTop: insets.top }]}>
          {/* Header */}
          <View style={styles.header}>
            <Pressable 
              style={({ pressed }) => [styles.headerBackButton, pressed && { opacity: 0.7 }]}
              onPress={() => {
                if (loadId) {
                  router.replace(`/trip/${loadId}`);
                } else if (router.canGoBack()) {
                  router.back();
                } else {
                  router.replace('/(app)');
                }
              }}
            >
              <Ionicons name="arrow-back" size={24} color={colors.foreground} />
            </Pressable>
            <Text style={styles.headerTitle}>Take Photo</Text>
            <Pressable style={({ pressed }) => [styles.cameraControlButton, pressed && { opacity: 0.7 }]} onPress={toggleFlash}>
              <Ionicons 
                name={flashMode === 'on' ? 'flash' : 'flash-off'} 
                size={22} 
                color={colors.foreground} 
              />
            </Pressable>
          </View>

          {/* Info Card */}
          <View style={styles.infoCard}>
            <View style={styles.infoIconContainer}>
              <Ionicons name="camera" size={22} color={colors.primary} />
            </View>
            <View style={styles.infoTextContainer}>
              <Text style={styles.infoLabel}>Capture Proof for</Text>
              <Text style={styles.infoValue}>
                {stopSequence ? `Stop ${stopSequence} • ` : ''}{locationName || `Load #${loadId?.slice(-8) || 'Unknown'}`}
              </Text>
            </View>
          </View>

          {/* Focus Frame — fills remaining space, centered */}
          <View style={styles.focusFrameArea}>
            <View style={styles.focusFrame}>
              <View style={[styles.focusCorner, styles.focusCornerTL]} />
              <View style={[styles.focusCorner, styles.focusCornerTR]} />
              <View style={[styles.focusCorner, styles.focusCornerBL]} />
              <View style={[styles.focusCorner, styles.focusCornerBR]} />
            </View>
          </View>

          {/* Bottom Controls */}
          <View style={[styles.bottomControls, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.controlSpacer} />

            <Pressable 
              style={({ pressed }) => [styles.captureButton, pressed && { opacity: 0.7 }]}
              onPress={capturePhoto}
              disabled={isCapturing}
            >
              <View style={styles.captureButtonOuter}>
                <View style={styles.captureButtonInner}>
                  {isCapturing ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Ionicons name="camera" size={28} color={colors.primaryForeground} />
                  )}
                </View>
              </View>
            </Pressable>

            <Pressable 
              style={({ pressed }) => [styles.switchCameraButton, pressed && { opacity: 0.7 }]}
              onPress={toggleCameraFacing}
            >
              <View style={styles.switchCameraInner}>
                <Ionicons name="sync" size={22} color={colors.foreground} />
              </View>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  permissionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing['2xl'],
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.foreground,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  permissionText: {
    fontSize: 16,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 24,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.md,
  },
  permissionButtonText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: '600',
  },
  backButtonAlt: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  backButtonAltText: {
    color: colors.foregroundMuted,
    fontSize: 16,
  },

  // Controls column — flex layout on top of camera (no absolute positioning)
  controlsColumn: {
    flex: 1,
    justifyContent: 'space-between',
  },

  // Header (overlaid on camera)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  headerBackButton: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Info Card (overlaid on camera)
  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: spacing.lg,
    borderRadius: borderRadius['2xl'],
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  infoIconContainer: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTextContainer: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },

  cameraControlButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Focus frame
  focusFrameArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusFrame: {
    width: 200,
    height: 200,
  },
  focusCorner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  focusCornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 8,
  },
  focusCornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopRightRadius: 8,
  },
  focusCornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomLeftRadius: 8,
  },
  focusCornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: 8,
  },

  // Bottom Controls (overlaid on camera)
  bottomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    gap: spacing['2xl'],
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  controlSpacer: {
    width: 56,
  },
  captureButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  captureButtonInner: {
    width: '100%',
    height: '100%',
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchCameraButton: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchCameraInner: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Preview
  previewContainer: {
    flex: 1,
    marginHorizontal: spacing.xl,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  previewImage: {
    flex: 1,
    width: '100%',
  },
  previewActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    backgroundColor: colors.background,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.muted,
    paddingVertical: spacing.lg,
    minHeight: 52,
    borderRadius: borderRadius.xl,
  },
  retakeButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  usePhotoButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    minHeight: 52,
    borderRadius: borderRadius.xl,
  },
  usePhotoButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
});
