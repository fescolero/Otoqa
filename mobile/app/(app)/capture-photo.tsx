import { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.backButtonAlt} 
          onPress={() => {
            if (loadId) {
              router.replace(`/trip/${loadId}`);
            } else {
              router.back();
            }
          }}
        >
          <Text style={styles.backButtonAltText}>Go Back</Text>
        </TouchableOpacity>
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

      console.log('[CapturePhoto] Photo captured:', photo);

      if (photo?.uri) {
        // Ensure URI has file:// prefix for Image component
        const uri = photo.uri.startsWith('file://') ? photo.uri : `file://${photo.uri}`;
        setCapturedPhoto(uri);
        console.log('[CapturePhoto] Set photo URI:', uri);
      } else {
        console.error('[CapturePhoto] No URI in photo result');
        Alert.alert('Error', 'Failed to capture photo. No image data received.');
      }
    } catch (error) {
      console.error('[CapturePhoto] Error capturing photo:', error);
      Alert.alert('Error', 'Failed to capture photo. Please try again.');
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
      // Store the photo URI in AsyncStorage so the trip screen can retrieve it
      await AsyncStorage.setItem(CAPTURED_PHOTO_KEY, capturedPhoto);
      console.log('[CapturePhoto] Saved photo URI to storage:', capturedPhoto);
      
      // Navigate back to the trip screen
      if (loadId) {
        router.replace(`/trip/${loadId}`);
      } else {
        router.back();
      }
    } catch (error) {
      console.error('[CapturePhoto] Failed to save photo:', error);
      Alert.alert('Error', 'Failed to save photo. Please try again.');
    }
  };

  // If we have a captured photo, show the preview
  if (capturedPhoto) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.container, { paddingTop: insets.top }]}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBackButton} onPress={retakePhoto}>
              <Ionicons name="arrow-back" size={24} color={colors.foreground} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Review Photo</Text>
            <View style={styles.headerSpacer} />
          </View>

          {/* Photo Preview */}
          <View style={styles.previewContainer}>
            <Image 
              source={{ uri: capturedPhoto }} 
              style={styles.previewImage}
              resizeMode="contain"
              onError={(e) => console.error('[CapturePhoto] Image load error:', e.nativeEvent.error)}
              onLoad={() => console.log('[CapturePhoto] Image loaded successfully')}
            />
          </View>

          {/* Action Buttons */}
          <View style={[styles.previewActions, { paddingBottom: insets.bottom + spacing.lg }]}>
            <TouchableOpacity style={styles.retakeButton} onPress={retakePhoto}>
              <Ionicons name="refresh" size={24} color={colors.foreground} />
              <Text style={styles.retakeButtonText}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.usePhotoButton} onPress={usePhoto}>
              <Ionicons name="checkmark" size={24} color={colors.primaryForeground} />
              <Text style={styles.usePhotoButtonText}>Use Photo</Text>
            </TouchableOpacity>
          </View>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity 
            style={styles.headerBackButton} 
            onPress={() => {
              if (loadId) {
                router.replace(`/trip/${loadId}`);
              } else {
                router.back();
              }
            }}
          >
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Take Photo</Text>
          <View style={styles.headerSpacer} />
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

        {/* Camera View */}
        <View style={styles.cameraContainer}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing={facing}
            flash={flashMode}
          >
            {/* Camera Overlay */}
            <View style={styles.cameraOverlay}>
              {/* Top controls */}
              <View style={styles.cameraTopControls}>
                <TouchableOpacity style={styles.cameraControlButton} onPress={toggleFlash}>
                  <Ionicons 
                    name={flashMode === 'on' ? 'flash' : 'flash-off'} 
                    size={22} 
                    color={colors.foreground} 
                  />
                </TouchableOpacity>
              </View>

              {/* Focus Frame */}
              <View style={styles.focusFrame}>
                <View style={[styles.focusCorner, styles.focusCornerTL]} />
                <View style={[styles.focusCorner, styles.focusCornerTR]} />
                <View style={[styles.focusCorner, styles.focusCornerBL]} />
                <View style={[styles.focusCorner, styles.focusCornerBR]} />
              </View>
            </View>
          </CameraView>
        </View>

        {/* Bottom Controls */}
        <View style={[styles.bottomControls, { paddingBottom: insets.bottom + spacing.md }]}>
          {/* Spacer for centering */}
          <View style={styles.controlSpacer} />

          {/* Capture Button */}
          <TouchableOpacity 
            style={styles.captureButton} 
            onPress={capturePhoto}
            disabled={isCapturing}
            activeOpacity={0.8}
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
          </TouchableOpacity>

          {/* Switch Camera */}
          <TouchableOpacity style={styles.switchCameraButton} onPress={toggleCameraFacing}>
            <View style={styles.switchCameraInner}>
              <Ionicons name="sync" size={22} color={colors.foreground} />
            </View>
          </TouchableOpacity>
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

  // Header
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
    backgroundColor: `${colors.muted}80`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
  },
  headerSpacer: {
    width: 44,
  },

  // Info Card
  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.xl,
    marginBottom: spacing.lg,
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: borderRadius['2xl'],
    borderWidth: 1,
    borderColor: `${colors.border}50`,
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
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },

  // Camera
  cameraContainer: {
    flex: 1,
    marginHorizontal: spacing.xl,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  cameraTopControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  cameraControlButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusFrame: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 200,
    height: 200,
    marginLeft: -100,
    marginTop: -100,
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

  // Bottom Controls
  bottomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    gap: spacing['2xl'],
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
    marginVertical: spacing.lg,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  previewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  previewActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.muted,
    paddingVertical: spacing.lg,
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
    borderRadius: borderRadius.xl,
  },
  usePhotoButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
});
