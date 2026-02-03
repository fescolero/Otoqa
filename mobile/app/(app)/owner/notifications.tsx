import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Linking,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';

// ============================================
// NOTIFICATION PREFERENCES PAGE
// Manage push notification settings
// ============================================

type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

// Dynamic import to handle Expo Go where native module isn't available
let Notifications: typeof import('expo-notifications') | null = null;
try {
  Notifications = require('expo-notifications');
} catch {
  // expo-notifications not available (running in Expo Go)
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>('undetermined');
  const [isLoading, setIsLoading] = useState(true);
  
  // Notification preferences (local state - would connect to backend in production)
  const [loadUpdates, setLoadUpdates] = useState(true);
  const [driverAlerts, setDriverAlerts] = useState(true);
  const [systemMessages, setSystemMessages] = useState(true);

  const checkPermissions = useCallback(async () => {
    if (!Notifications) {
      setPermissionStatus('unavailable');
      setIsLoading(false);
      return;
    }
    
    try {
      const { status } = await Notifications.getPermissionsAsync();
      setPermissionStatus(status as PermissionStatus);
    } catch (error) {
      console.error('Error checking notification permissions:', error);
      setPermissionStatus('unavailable');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  // Re-check permissions when app comes to foreground
  useEffect(() => {
    if (!Notifications) return;
    
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {
      checkPermissions();
    });
    return () => subscription.remove();
  }, [checkPermissions]);

  const requestPermissions = async () => {
    if (!Notifications) {
      Alert.alert(
        'Development Build Required',
        'Push notifications require a development build. This feature is not available in Expo Go.',
        [{ text: 'OK' }]
      );
      return;
    }
    
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      setPermissionStatus(status as PermissionStatus);
      
      if (status === 'denied') {
        Alert.alert(
          'Notifications Disabled',
          'To enable notifications, please go to your device settings and allow notifications for this app.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: openSettings },
          ]
        );
      }
    } catch (error) {
      console.error('Error requesting notification permissions:', error);
    }
  };

  const openSettings = () => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  };

  const getStatusColor = () => {
    switch (permissionStatus) {
      case 'granted':
        return colors.success;
      case 'denied':
        return colors.destructive;
      case 'unavailable':
        return colors.foregroundMuted;
      default:
        return colors.foregroundMuted;
    }
  };

  const getStatusText = () => {
    switch (permissionStatus) {
      case 'granted':
        return 'Enabled';
      case 'denied':
        return 'Disabled';
      case 'unavailable':
        return 'Unavailable';
      default:
        return 'Not Set';
    }
  };

  const getStatusDescription = () => {
    switch (permissionStatus) {
      case 'granted':
        return 'Push notifications are enabled. You will receive alerts for important updates.';
      case 'denied':
        return 'Push notifications are disabled. Enable them in your device settings to receive alerts.';
      case 'unavailable':
        return 'Push notifications require a development build. This feature is not available in Expo Go.';
      default:
        return 'Notification permissions have not been requested yet.';
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notification Preferences</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Permission Status Card */}
        <View style={styles.statusCard}>
          <View style={styles.statusHeader}>
            <View style={[styles.statusIconContainer, { backgroundColor: getStatusColor() + '20' }]}>
              <Ionicons 
                name={permissionStatus === 'granted' ? 'notifications' : 'notifications-off'} 
                size={24} 
                color={getStatusColor()} 
              />
            </View>
            <View style={styles.statusInfo}>
              <Text style={styles.statusLabel}>Push Notifications</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
                <Text style={[styles.statusText, { color: getStatusColor() }]}>
                  {isLoading ? 'Checking...' : getStatusText()}
                </Text>
              </View>
            </View>
          </View>
          
          <Text style={styles.statusDescription}>
            {getStatusDescription()}
          </Text>

          {permissionStatus !== 'granted' && permissionStatus !== 'unavailable' && (
            <TouchableOpacity 
              style={styles.enableButton}
              onPress={permissionStatus === 'denied' ? openSettings : requestPermissions}
            >
              <Ionicons 
                name={permissionStatus === 'denied' ? 'settings-outline' : 'notifications-outline'} 
                size={18} 
                color={colors.primaryForeground} 
              />
              <Text style={styles.enableButtonText}>
                {permissionStatus === 'denied' ? 'Open Settings' : 'Enable Notifications'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Notification Types */}
        {permissionStatus === 'granted' && (
          <>
            <Text style={styles.sectionTitle}>Notification Types</Text>
            <View style={styles.card}>
              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <View style={[styles.settingIcon, { backgroundColor: colors.primary + '20' }]}>
                    <Ionicons name="cube" size={18} color={colors.primary} />
                  </View>
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>Load Updates</Text>
                    <Text style={styles.settingSubtitle}>New assignments, status changes</Text>
                  </View>
                </View>
                <Switch
                  value={loadUpdates}
                  onValueChange={setLoadUpdates}
                  trackColor={{ false: colors.muted, true: colors.primary }}
                  thumbColor={colors.foreground}
                />
              </View>

              <View style={styles.divider} />

              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <View style={[styles.settingIcon, { backgroundColor: '#FFA50020' }]}>
                    <Ionicons name="people" size={18} color="#FFA500" />
                  </View>
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>Driver Alerts</Text>
                    <Text style={styles.settingSubtitle}>Check-ins, location updates</Text>
                  </View>
                </View>
                <Switch
                  value={driverAlerts}
                  onValueChange={setDriverAlerts}
                  trackColor={{ false: colors.muted, true: colors.primary }}
                  thumbColor={colors.foreground}
                />
              </View>

              <View style={styles.divider} />

              <View style={styles.settingItem}>
                <View style={styles.settingInfo}>
                  <View style={[styles.settingIcon, { backgroundColor: colors.muted }]}>
                    <Ionicons name="information-circle" size={18} color={colors.foreground} />
                  </View>
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>System Messages</Text>
                    <Text style={styles.settingSubtitle}>App updates, announcements</Text>
                  </View>
                </View>
                <Switch
                  value={systemMessages}
                  onValueChange={setSystemMessages}
                  trackColor={{ false: colors.muted, true: colors.primary }}
                  thumbColor={colors.foreground}
                />
              </View>
            </View>
          </>
        )}

        {/* Info Section */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle-outline" size={20} color={colors.foregroundMuted} />
          <Text style={styles.infoText}>
            Notification preferences are stored on this device. Some critical alerts may still be sent regardless of your preferences.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: typography.lg,
    fontWeight: '700',
    color: colors.foreground,
  },
  headerSpacer: {
    width: 40,
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  
  // Status Card
  statusCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginTop: spacing.md,
    ...shadows.md,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  statusIconContainer: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  statusInfo: {
    flex: 1,
  },
  statusLabel: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: typography.sm,
    fontWeight: '600',
  },
  statusDescription: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  enableButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
  },
  enableButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.primaryForeground,
  },

  // Section
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    ...shadows.md,
  },
  
  // Settings
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  settingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    fontSize: typography.base,
    fontWeight: '500',
    color: colors.foreground,
  },
  settingSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 60,
  },

  // Info Card
  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.muted,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  infoText: {
    flex: 1,
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    lineHeight: 20,
  },
});
