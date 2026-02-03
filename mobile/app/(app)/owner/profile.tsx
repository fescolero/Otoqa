import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';
import { useAppMode, useCarrierOwner } from '../_layout';
import { useClerk } from '@clerk/clerk-expo';
import { useLanguage } from '../../../lib/LanguageContext';

// ============================================
// DISPATCHER PROFILE PAGE
// Profile settings, mode selection, preferences
// ============================================

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { canSwitchModes, setMode } = useAppMode();
  const { orgName } = useCarrierOwner();
  const { signOut } = useClerk();
  const { currentLanguage, t } = useLanguage();

  const handleSignOut = async () => {
    await signOut();
  };

  const handleSwitchToDriver = () => {
    setMode('driver');
  };

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

  return (
    <ScrollView 
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + 120 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
      </View>

      {/* User Profile Card */}
      <View style={styles.profileCard}>
        <View style={styles.profileRow}>
          <View style={styles.statusDot} />
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{orgName || 'Dispatcher'}</Text>
            <Text style={styles.profileRole}>Senior Dispatcher • ID: DSP-4429</Text>
          </View>
        </View>
      </View>

      {/* Mode Selection */}
      {canSwitchModes && (
        <>
          <Text style={styles.sectionTitle}>{t('profile.role')}</Text>
          <View style={styles.card}>
            <TouchableOpacity style={styles.menuItem} onPress={handleSwitchToDriver}>
              <View style={[styles.iconContainer, { backgroundColor: colors.primary + '20' }]}>
                <Ionicons name="car" size={20} color={colors.primary} />
              </View>
              <View style={styles.menuItemContent}>
                <Text style={styles.menuItemTitle}>{t('profile.switchToDriver')}</Text>
                <Text style={styles.menuItemSubtitle}>{t('profile.viewAsDriver')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Dispatcher Controls */}
      <View style={styles.sectionTitleRow}>
        <Text style={styles.sectionTitle}>Dispatcher Controls</Text>
        <View style={styles.comingSoonBadge}>
          <Text style={styles.comingSoonText}>Coming Soon</Text>
        </View>
      </View>
      <View style={[styles.card, styles.cardDisabled]}>
        <View style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <MaterialCommunityIcons name="routes" size={20} color={colors.foregroundMuted} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitleDisabled}>Route Optimization</Text>
            <Text style={styles.menuItemSubtitle}>AI-assisted scheduling</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </View>

        <View style={styles.divider} />

        <View style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="flash" size={20} color={colors.foregroundMuted} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitleDisabled}>Auto-Assignment</Text>
            <Text style={styles.menuItemSubtitle}>Priority based dispatching</Text>
          </View>
          <Switch
            value={false}
            disabled={true}
            trackColor={{ false: colors.muted, true: colors.primary }}
            thumbColor={colors.foregroundMuted}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="warning" size={20} color={colors.foregroundMuted} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitleDisabled}>Emergency Protocols</Text>
            <Text style={styles.menuItemSubtitle}>SOS & Critical incident config</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </View>
      </View>

      {/* Settings Section */}
      <Text style={styles.sectionTitle}>{t('profile.settings')}</Text>
      <View style={styles.card}>
        <TouchableOpacity 
          style={styles.menuItem}
          onPress={() => router.push('/(app)/language')}
        >
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="globe" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>{t('profile.language')}</Text>
          </View>
          <View style={styles.valueRow}>
            <Text style={styles.menuItemValue}>{getLanguageDisplayName()}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
          </View>
        </TouchableOpacity>
      </View>

      {/* Sign Out Button */}
      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Ionicons name="log-out-outline" size={20} color={colors.destructive} />
        <Text style={styles.signOutText}>{t('profile.signOut')}</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
  },
  header: {
    paddingVertical: spacing.md,
  },
  headerTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  profileCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadows.md,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#4CAF50',
    marginRight: spacing.md,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  profileRole: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.md,
    marginTop: spacing.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  comingSoonBadge: {
    backgroundColor: colors.primary + '20',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  comingSoonText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: colors.primary,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    ...shadows.md,
  },
  cardDisabled: {
    opacity: 0.6,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  menuItemContent: {
    flex: 1,
  },
  menuItemTitle: {
    fontSize: typography.base,
    fontWeight: '500',
    color: colors.foreground,
  },
  menuItemTitleDisabled: {
    fontSize: typography.base,
    fontWeight: '500',
    color: colors.foregroundMuted,
  },
  menuItemSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  menuItemValue: {
    fontSize: typography.sm,
    color: colors.primary,
    fontWeight: '500',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 56,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${colors.destructive}15`,
    borderWidth: 1,
    borderColor: `${colors.destructive}40`,
    height: 56,
    borderRadius: borderRadius.xl,
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  signOutText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.destructive,
  },
});
