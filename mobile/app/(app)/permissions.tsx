import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

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

// ============================================
// PERMISSIONS SCREEN
// App Permissions Management
// ============================================

interface PermissionItem {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  description: string;
  enabled: boolean;
  required: boolean;
}

export default function PermissionsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [permissions, setPermissions] = useState<PermissionItem[]>([
    {
      id: 'location',
      icon: 'location',
      title: 'Location Services',
      subtitle: 'Required for route tracking',
      description: 'Allows the app to provide turn-by-turn navigation and estimated arrival times for dispatchers.',
      enabled: false,
      required: true,
    },
    {
      id: 'camera',
      icon: 'camera',
      title: 'Camera',
      subtitle: 'Used for document scanning',
      description: 'Needed to take photos of bills of lading (BOL) and proof of delivery documents.',
      enabled: false,
      required: true,
    },
    {
      id: 'notifications',
      icon: 'notifications',
      title: 'Notifications',
      subtitle: 'Load updates and alerts',
      description: 'Receive real-time alerts for new assignments, schedule changes, and weather warnings.',
      enabled: false,
      required: true,
    },
    {
      id: 'microphone',
      icon: 'mic',
      title: 'Microphone',
      subtitle: 'Voice-to-text messaging',
      description: 'Enable this to use voice commands or record audio notes for load summaries.',
      enabled: false,
      required: false,
    },
    {
      id: 'photos',
      icon: 'images',
      title: 'Photo Library',
      subtitle: 'Access saved photos',
      description: 'Allows you to upload previously taken photos of receipts and documentation.',
      enabled: false,
      required: false,
    },
  ]);

  const checkPermissions = useCallback(async () => {
    const locationStatus = await Location.getForegroundPermissionsAsync();
    const cameraStatus = await Camera.getCameraPermissionsAsync();
    const micStatus = await Camera.getMicrophonePermissionsAsync();
    const photoStatus = await ImagePicker.getMediaLibraryPermissionsAsync();

    const statusById: Record<string, boolean> = {
      location: locationStatus.granted,
      camera: cameraStatus.granted,
      notifications: true,
      microphone: micStatus.granted,
      photos: photoStatus.granted,
    };

    setPermissions((current) =>
      current.map((permission) => {
        const enabled = statusById[permission.id];
        return typeof enabled === 'boolean' ? { ...permission, enabled } : permission;
      })
    );
  }, []);

  // Check permission statuses on mount
  useEffect(() => {
    void checkPermissions();
  }, [checkPermissions]);

  const requestPermission = async (id: string) => {
    switch (id) {
      case 'location':
        await Location.requestForegroundPermissionsAsync();
        break;
      case 'camera':
        await Camera.requestCameraPermissionsAsync();
        break;
      case 'notifications':
        // Open device settings for notifications
        openSettings();
        return;
      case 'microphone':
        await Camera.requestMicrophonePermissionsAsync();
        break;
      case 'photos':
        await ImagePicker.requestMediaLibraryPermissionsAsync();
        break;
    }
    // Refresh permissions after request
    await checkPermissions();
  };

  const openSettings = () => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  };

  const requiredPermissions = permissions.filter(p => p.required);
  const optionalPermissions = permissions.filter(p => !p.required);

  const renderPermissionCard = (permission: PermissionItem) => (
    <View key={permission.id} style={styles.permissionCard}>
      <View style={styles.permissionHeader}>
        <View style={styles.permissionIconContainer}>
          <Ionicons name={permission.icon} size={20} color={colors.foregroundMuted} />
        </View>
        <View style={styles.permissionTitleContainer}>
          <Text style={styles.permissionTitle}>{permission.title}</Text>
          <Text style={styles.permissionSubtitle}>{permission.subtitle}</Text>
        </View>
        <View style={[
          styles.statusBadge,
          permission.enabled ? styles.statusBadgeEnabled : styles.statusBadgeDisabled
        ]}>
          <View style={[
            styles.statusDot,
            permission.enabled ? styles.statusDotEnabled : styles.statusDotDisabled
          ]} />
          <Text style={[
            styles.statusText,
            permission.enabled ? styles.statusTextEnabled : styles.statusTextDisabled
          ]}>
            {permission.enabled ? 'ENABLED' : 'DISABLED'}
          </Text>
        </View>
      </View>
      <Text style={styles.permissionDescription}>{permission.description}</Text>
      {!permission.enabled && (
        <TouchableOpacity 
          style={styles.grantButton}
          onPress={() => requestPermission(permission.id)}
        >
          <Text style={styles.grantButtonText}>Grant Permission</Text>
          <Ionicons name="arrow-forward" size={16} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>App Permissions</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Description */}
        <Text style={styles.description}>
          To get the best experience and ensure all safety features work correctly, the app requires the following
        </Text>

        {/* Required Permissions */}
        <Text style={styles.sectionTitle}>Required Permissions</Text>
        <View style={styles.permissionsSection}>
          {requiredPermissions.map(renderPermissionCard)}
        </View>

        {/* Optional Permissions */}
        <Text style={styles.sectionTitle}>Optional Permissions</Text>
        <View style={styles.permissionsSection}>
          {optionalPermissions.map(renderPermissionCard)}
        </View>

        {/* Open Settings Button */}
        <TouchableOpacity style={styles.settingsButton} onPress={openSettings}>
          <Ionicons name="settings-outline" size={20} color={colors.foreground} />
          <Text style={styles.settingsButtonText}>Open Device Settings</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
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

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
  },

  // Description
  description: {
    fontSize: 15,
    color: colors.foregroundMuted,
    lineHeight: 22,
    marginBottom: spacing.xl,
  },

  // Section
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.md,
    marginTop: spacing.md,
  },

  // Permissions Section
  permissionsSection: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },

  // Permission Card
  permissionCard: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.border}30`,
  },
  permissionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  permissionIconContainer: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    backgroundColor: `${colors.muted}80`,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  permissionTitleContainer: {
    flex: 1,
  },
  permissionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 2,
  },
  permissionSubtitle: {
    fontSize: 13,
    color: colors.foregroundMuted,
  },
  permissionDescription: {
    fontSize: 14,
    color: colors.foregroundMuted,
    lineHeight: 20,
    fontStyle: 'italic',
  },

  // Status Badge
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
  },
  statusBadgeEnabled: {
    backgroundColor: `${colors.success}15`,
  },
  statusBadgeDisabled: {
    backgroundColor: `${colors.destructive}15`,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotEnabled: {
    backgroundColor: colors.success,
  },
  statusDotDisabled: {
    backgroundColor: colors.destructive,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  statusTextEnabled: {
    color: colors.success,
  },
  statusTextDisabled: {
    color: colors.destructive,
  },

  // Grant Button
  grantButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  grantButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },

  // Settings Button
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.muted,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius['2xl'],
    marginTop: spacing.xl,
  },
  settingsButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
});
