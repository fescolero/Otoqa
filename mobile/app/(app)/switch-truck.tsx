import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';

// ============================================
// DESIGN SYSTEM
// ============================================
const colors = {
  background: '#1a1d21',
  foreground: '#f3f4f6',
  foregroundMuted: '#9ca3af',
  primary: '#ff6b00',
  primaryForeground: '#1a1d21',
  secondary: '#eab308',
  muted: '#2d323b',
  card: '#22262b',
  cardForeground: '#f3f4f6',
  border: '#3f4552',
  destructive: '#ef4444',
  success: '#10b981',
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
  full: 9999,
};

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCANNER_SIZE = Math.min(SCREEN_WIDTH * 0.65, SCREEN_HEIGHT * 0.32);

// ============================================
// QR CODE DATA TYPES
// ============================================
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

/**
 * Parse and validate QR code data
 */
function parseQRCode(rawData: string): ParsedQR {
  try {
    const parsed = JSON.parse(rawData);
    
    // Validate QR code structure
    if (parsed.type !== 'otoqa-truck') {
      return { valid: false, error: 'Invalid QR code type' };
    }
    
    if (!parsed.truckId || typeof parsed.truckId !== 'string') {
      return { valid: false, error: 'Missing truck ID' };
    }
    
    if (!parsed.unitId || typeof parsed.unitId !== 'string') {
      return { valid: false, error: 'Missing unit ID' };
    }
    
    return { valid: true, data: parsed as QRCodeData };
  } catch {
    return { valid: false, error: 'Invalid QR code format' };
  }
}

// ============================================
// SWITCH TRUCK SCREEN
// QR Code Scanner for Vehicle Assignment
// ============================================

export default function SwitchTruckScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [scannedData, setScannedData] = useState<ParsedQR | null>(null);
  const [flashOn, setFlashOn] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualId, setManualId] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);

  // Get driver profile from Convex
  const profile = useQuery(api.driverMobile.getMyProfile);
  
  // Switch truck mutation
  const switchTruck = useMutation(api.driverMobile.switchTruck);

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission]);

  // Current vehicle info from profile
  const currentVehicle = profile?.truck
    ? {
        unitNumber: `Unit #${profile.truck.unitId}`,
        model: [profile.truck.make, profile.truck.model].filter(Boolean).join(' ') || 'Unknown Model',
        isActive: true,
      }
    : {
        unitNumber: 'No truck assigned',
        model: 'Scan a QR code to assign a truck',
        isActive: false,
      };

  const handleBarCodeScanned = useCallback(({ data }: { type: string; data: string }) => {
    if (!scanned) {
      setScanned(true);
      const parsed = parseQRCode(data);
      setScannedData(parsed);
      
      if (!parsed.valid) {
        Alert.alert('Invalid QR Code', parsed.error || 'Please scan a valid truck QR code.');
      }
    }
  }, [scanned]);

  const handleConfirmScan = async () => {
    if (!scannedData?.valid || !scannedData.data || !profile) {
      Alert.alert('Error', 'Please scan a valid QR code first.');
      return;
    }

    setIsSwitching(true);

    try {
      const result = await switchTruck({
        driverId: profile._id,
        truckId: scannedData.data.truckId as Id<'trucks'>,
      });

      if (result.success) {
        Alert.alert(
          'Truck Switched',
          result.message,
          [
            {
              text: 'OK',
              onPress: () => router.back(),
            },
          ]
        );
      } else {
        Alert.alert('Unable to Switch', result.message);
        resetScan();
      }
    } catch (error) {
      console.error('Switch truck error:', error);
      Alert.alert('Error', 'Failed to switch truck. Please try again.');
      resetScan();
    } finally {
      setIsSwitching(false);
    }
  };

  const handleManualEntry = () => {
    // Manual entry is not fully supported yet since we need the Convex ID
    // For now, show a message to use QR scanning instead
    Alert.alert(
      'Manual Entry Not Available',
      'Please scan the QR code on the truck to switch vehicles. Manual entry will be available in a future update.',
      [{ text: 'OK', onPress: () => setShowManualEntry(false) }]
    );
  };

  const resetScan = () => {
    setScanned(false);
    setScannedData(null);
  };

  // Loading state while fetching profile
  if (profile === undefined) {
    return (
      <View style={[styles.container, styles.centerContent, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  // Not authenticated
  if (profile === null) {
    return (
      <View style={[styles.container, styles.centerContent, { paddingTop: insets.top }]}>
        <Ionicons name="alert-circle-outline" size={64} color={colors.destructive} />
        <Text style={styles.errorTitle}>Not Authenticated</Text>
        <Text style={styles.errorText}>Please sign in to switch trucks.</Text>
        <TouchableOpacity style={styles.errorButton} onPress={() => router.back()}>
          <Text style={styles.errorButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!permission) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={styles.permissionText}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.permissionContainer}>
          <Ionicons name="camera-outline" size={64} color={colors.foregroundMuted} />
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionText}>
            We need camera access to scan the QR code on your vehicle.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.manualEntryLink} 
            onPress={() => setShowManualEntry(true)}
          >
            <Text style={styles.manualEntryLinkText}>Or enter ID manually</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Switch Truck</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Scanner Area */}
      <View style={styles.scannerContainer}>
        <Text style={styles.scannerTitle}>Align QR Code</Text>
        <Text style={styles.scannerSubtitle}>
          Scan the QR code located on the dashboard or door frame of your new vehicle.
        </Text>

        <View style={styles.scannerFrame}>
          <CameraView
            style={styles.camera}
            facing="back"
            enableTorch={flashOn}
            barcodeScannerSettings={{
              barcodeTypes: ['qr'],
            }}
            onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          />
          
          {/* Corner brackets */}
          <View style={styles.cornerTopLeft} />
          <View style={styles.cornerTopRight} />
          <View style={styles.cornerBottomLeft} />
          <View style={styles.cornerBottomRight} />

          {/* Scanning line */}
          <View style={styles.scanLine} />

          {/* QR Icon overlay when scanned */}
          {scanned && scannedData?.valid && (
            <View style={styles.scannedOverlay}>
              <Ionicons name="checkmark-circle" size={80} color={colors.success} />
              <Text style={styles.scannedText}>Truck Found!</Text>
              <Text style={styles.scannedUnitId}>{scannedData.data?.unitId}</Text>
            </View>
          )}
          
          {/* Error overlay for invalid scan */}
          {scanned && !scannedData?.valid && (
            <View style={styles.scannedOverlay}>
              <Ionicons name="close-circle" size={80} color={colors.destructive} />
              <Text style={styles.scannedErrorText}>Invalid QR Code</Text>
              <TouchableOpacity style={styles.rescanButton} onPress={resetScan}>
                <Text style={styles.rescanButtonText}>Tap to Scan Again</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Flash toggle */}
        <TouchableOpacity
          style={[styles.flashButton, flashOn && styles.flashButtonActive]}
          onPress={() => setFlashOn(!flashOn)}
        >
          <Ionicons
            name={flashOn ? 'flashlight' : 'flashlight-outline'}
            size={24}
            color={flashOn ? colors.primaryForeground : colors.foregroundMuted}
          />
        </TouchableOpacity>
        <Text style={styles.flashLabel}>
          {flashOn ? 'Flashlight On' : 'Tap for Flashlight'}
        </Text>
      </View>

      {/* Bottom Section */}
      <View style={[styles.bottomSection, { paddingBottom: insets.bottom + spacing.sm }]}>
        {/* Current Vehicle */}
        <Text style={styles.currentVehicleLabel}>CURRENT VEHICLE</Text>
        <View style={styles.currentVehicleCard}>
          <View style={styles.vehicleIcon}>
            <MaterialCommunityIcons name="truck" size={20} color={colors.primary} />
          </View>
          <View style={styles.vehicleInfo}>
            <Text style={styles.vehicleUnit}>{currentVehicle.unitNumber}</Text>
            <Text style={styles.vehicleModel}>{currentVehicle.model}</Text>
          </View>
          {currentVehicle.isActive && (
            <View style={styles.activeBadge}>
              <Text style={styles.activeBadgeText} maxFontSizeMultiplier={1.2}>ACTIVE</Text>
            </View>
          )}
        </View>

        {/* Action Buttons */}
        <TouchableOpacity
          style={[
            styles.confirmButton, 
            (!scannedData?.valid || isSwitching) && styles.confirmButtonDisabled
          ]}
          onPress={scannedData?.valid ? handleConfirmScan : resetScan}
          activeOpacity={0.8}
          disabled={isSwitching}
        >
          {isSwitching ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <MaterialCommunityIcons name="qrcode-scan" size={18} color={colors.primaryForeground} />
          )}
          <Text style={styles.confirmButtonText}>
            {isSwitching 
              ? 'Switching...' 
              : scannedData?.valid 
                ? `Switch to ${scannedData.data?.unitId}` 
                : 'Scan QR Code'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.manualButton}
          onPress={() => setShowManualEntry(true)}
          activeOpacity={0.8}
        >
          <Ionicons name="keypad" size={18} color={colors.foreground} />
          <Text style={styles.manualButtonText}>Enter ID Manually</Text>
        </TouchableOpacity>
      </View>

      {/* Manual Entry Modal */}
      <Modal
        visible={showManualEntry}
        animationType="slide"
        transparent
        onRequestClose={() => setShowManualEntry(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowManualEntry(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.sheetHandle} />

            <Text style={styles.modalTitle}>Enter Vehicle ID</Text>
            <Text style={styles.modalSubtitle}>
              Enter the vehicle ID found on the dashboard or registration documents.
            </Text>

            <TextInput
              style={styles.modalInput}
              value={manualId}
              onChangeText={setManualId}
              placeholder="e.g., 4402-TX"
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            <TouchableOpacity
              style={styles.modalConfirmButton}
              onPress={handleManualEntry}
              activeOpacity={0.8}
            >
              <Text style={styles.modalConfirmButtonText}>Assign Vehicle</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={() => setShowManualEntry(false)}
            >
              <Text style={styles.modalCancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Loading & Error states
  loadingText: {
    fontSize: 16,
    color: colors.foregroundMuted,
    marginTop: spacing.md,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  errorText: {
    fontSize: 15,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  errorButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
  },
  errorButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryForeground,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
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

  // Permission
  permissionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['2xl'],
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  permissionText: {
    fontSize: 15,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  manualEntryLink: {
    marginTop: spacing.lg,
  },
  manualEntryLinkText: {
    fontSize: 15,
    color: colors.primary,
    fontWeight: '500',
  },

  // Scanner
  scannerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.sm,
  },
  scannerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  scannerSubtitle: {
    fontSize: 13,
    color: colors.foregroundMuted,
    textAlign: 'center',
    paddingHorizontal: spacing['2xl'],
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  scannerFrame: {
    width: SCANNER_SIZE,
    height: SCANNER_SIZE,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  camera: {
    width: '100%',
    height: '100%',
  },
  cornerTopLeft: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 40,
    height: 40,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderColor: colors.primary,
    borderTopLeftRadius: borderRadius.lg,
  },
  cornerTopRight: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 40,
    height: 40,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderColor: colors.primary,
    borderTopRightRadius: borderRadius.lg,
  },
  cornerBottomLeft: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 40,
    height: 40,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderColor: colors.primary,
    borderBottomLeftRadius: borderRadius.lg,
  },
  cornerBottomRight: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 40,
    height: 40,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderColor: colors.primary,
    borderBottomRightRadius: borderRadius.lg,
  },
  scanLine: {
    position: 'absolute',
    top: '15%',
    left: spacing.lg,
    right: spacing.lg,
    height: 2,
    backgroundColor: colors.primary,
  },
  scannedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${colors.background}E0`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannedText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.success,
    marginTop: spacing.md,
  },
  scannedUnitId: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.foreground,
    marginTop: spacing.xs,
  },
  scannedErrorText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.destructive,
    marginTop: spacing.md,
  },
  rescanButton: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.muted,
    borderRadius: borderRadius.md,
  },
  rescanButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.foreground,
  },
  flashButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  flashButtonActive: {
    backgroundColor: colors.primary,
  },
  flashLabel: {
    fontSize: 12,
    color: colors.foregroundMuted,
    marginTop: spacing.xs,
  },

  // Bottom Section
  bottomSection: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  currentVehicleLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  currentVehicleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  vehicleIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  vehicleInfo: {
    flex: 1,
  },
  vehicleUnit: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  vehicleModel: {
    fontSize: 12,
    color: colors.foregroundMuted,
    marginTop: 1,
  },
  activeBadge: {
    backgroundColor: `${colors.success}25`,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
  },
  activeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.success,
    letterSpacing: 0.5,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.sm,
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.primaryForeground,
  },
  manualButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.muted,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
  },
  manualButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${colors.background}E0`,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: borderRadius['2xl'],
    borderTopRightRadius: borderRadius['2xl'],
    padding: spacing['2xl'],
    paddingBottom: spacing['2xl'] + 20,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: colors.muted,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.xl,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.sm,
  },
  modalSubtitle: {
    fontSize: 15,
    color: colors.foregroundMuted,
    marginBottom: spacing.xl,
    lineHeight: 22,
  },
  modalInput: {
    backgroundColor: colors.muted,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: spacing.xl,
    letterSpacing: 2,
  },
  modalConfirmButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius['2xl'],
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  modalConfirmButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.primaryForeground,
  },
  modalCancelButton: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  modalCancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
});
