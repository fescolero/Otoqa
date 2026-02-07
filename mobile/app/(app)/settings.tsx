import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useClerk } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useDriver, useAppMode } from './_layout';
import { useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';

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
// PROFILE / SETTINGS SCREEN
// Driver Profile, Settings & Support
// ============================================

export default function SettingsScreen() {
  const { signOut } = useClerk();
  const router = useRouter();
  const { driverName, driverId } = useDriver();
  const { canSwitchModes, setMode } = useAppMode();
  const { currentLanguage, t } = useLanguage();

  const [lastSynced] = useState<string>('2 minutes ago');

  // Get display name for current language
  const getLanguageDisplayName = () => {
    switch (currentLanguage) {
      case 'system':
        return 'System Default';
      case 'en':
        return 'English';
      case 'es':
        return 'Español';
      default:
        return 'English';
    }
  };

  // Handle sign out
  const handleSignOut = () => {
    Alert.alert(
      t('profile.signOut'),
      t('profile.signOutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profile.signOut'),
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/(auth)/sign-in');
          },
        },
      ]
    );
  };

  // Generate driver ID from actual ID or fallback
  const getDriverDisplayId = () => {
    if (driverId) {
      // Use last 6 characters of actual ID
      const shortId = driverId.slice(-6).toUpperCase();
      return `TRK-${shortId}-CA`;
    }
    return 'TRK-000000-CA';
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header - Sticky */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
      </View>

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Card */}
        <View style={styles.profileCard}>
          <View style={styles.profileRow}>
            <View style={styles.onlineIndicator} />
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{driverName || 'Driver'}</Text>
              <Text style={styles.profileId}>Driver ID: {getDriverDisplayId()}</Text>
            </View>
          </View>
        </View>

        {/* Role Switch Section - Only shown for owner-operators */}
        {canSwitchModes && (
          <>
            <Text style={styles.sectionTitle}>{t('profile.role')}</Text>
            <View style={styles.menuSection}>
              <TouchableOpacity 
                style={[styles.menuRow, styles.menuRowLast]}
                onPress={() => setMode('owner')}
              >
                <View style={[styles.menuIconContainer, styles.menuIconOrange]}>
                  <MaterialCommunityIcons name="monitor-dashboard" size={20} color={colors.primary} />
                </View>
                <View style={styles.menuTextContainer}>
                  <Text style={styles.menuLabel}>{t('profile.switchToDispatcher')}</Text>
                  <Text style={styles.menuSubtitle}>{t('profile.manageLoadsDriversFleet')}</Text>
                </View>
                <Ionicons name="swap-horizontal" size={20} color={colors.primary} />
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Settings Section */}
        <Text style={styles.sectionTitle}>{t('profile.settings')}</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity 
            style={styles.menuRow}
            onPress={() => router.push('/notifications')}
          >
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="notifications" size={20} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.menuLabel}>{t('profile.notifications')}</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.menuRow}
            onPress={() => router.push('/language')}
          >
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="globe" size={20} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.menuLabel}>{t('profile.language')}</Text>
            <Text style={styles.menuValue}>{getLanguageDisplayName()}</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.menuRow, styles.menuRowLast]}
            onPress={() => router.push('/permissions')}
          >
            <View style={[styles.menuIconContainer, styles.menuIconBlue]}>
              <Ionicons name="shield-checkmark" size={20} color="#3b82f6" />
            </View>
            <Text style={styles.menuLabel}>{t('profile.permissions')}</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>
        </View>

        {/* App Information Section */}
        <Text style={styles.sectionTitle}>{t('profile.appInfo')}</Text>
        <View style={styles.menuSection}>
          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="phone-portrait" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>{t('profile.appVersion')}</Text>
              <Text style={styles.menuSubtitle}>{t('profile.currentVersion')}</Text>
            </View>
            <Text style={styles.menuValueBold}>v2.4.0</Text>
          </View>

          <View style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="sync" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>{t('profile.backgroundSync')}</Text>
              <Text style={styles.menuSubtitle}>{t('profile.lastSynced', { time: lastSynced })}</Text>
            </View>
            <View style={styles.activeBadge}>
              <View style={styles.activeDot} />
              <Text style={styles.activeBadgeText} maxFontSizeMultiplier={1.2}>ACTIVE</Text>
            </View>
          </View>
        </View>

        {/* Support Section */}
        <Text style={styles.sectionTitle}>{t('profile.support')}</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="chatbubble-ellipses" size={20} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.menuLabel}>{t('profile.helpCenter')}</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="call" size={20} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.menuLabel}>{t('profile.contactDispatch')}</Text>
            <View style={styles.availableBadge}>
              <Text style={styles.availableBadgeText} maxFontSizeMultiplier={1.2}>{t('profile.available')}</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Sign Out Button */}
        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Ionicons name="log-out-outline" size={20} color={colors.destructive} />
          <Text style={styles.signOutText}>{t('profile.signOut')}</Text>
        </TouchableOpacity>

        {/* Bottom spacing for nav */}
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
  },
  
  // Header
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.foreground,
  },
  
  // Profile Card
  profileCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  onlineIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.success,
    marginRight: spacing.md,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 2,
  },
  profileId: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  
  // Section Title
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.md,
    marginTop: spacing.md,
  },
  
  // Menu Section
  menuSection: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.border}30`,
    gap: spacing.md,
  },
  menuRowLast: {
    borderBottomWidth: 0,
  },
  menuIconContainer: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIconMuted: {
    backgroundColor: `${colors.muted}80`,
  },
  menuIconBlue: {
    backgroundColor: '#3b82f620',
  },
  menuIconOrange: {
    backgroundColor: `${colors.primary}20`,
  },
  menuTextContainer: {
    flex: 1,
  },
  menuLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.foreground,
    flex: 1,
  },
  menuSubtitle: {
    fontSize: 13,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  menuValue: {
    fontSize: 14,
    color: colors.foregroundMuted,
    marginRight: spacing.sm,
  },
  menuValueBold: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  
  // Badges
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: `${colors.success}15`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  activeBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
  },
  availableBadge: {
    backgroundColor: `${colors.success}15`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
  },
  availableBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
  },
  
  // Sign Out
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${colors.destructive}15`,
    borderWidth: 1,
    borderColor: `${colors.destructive}40`,
    height: 56,
    borderRadius: borderRadius['2xl'],
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  signOutText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.destructive,
  },
});
