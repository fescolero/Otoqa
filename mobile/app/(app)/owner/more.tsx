import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';

// ============================================
// MORE PAGE - Additional dispatcher features
// Console access, settings, support
// ============================================

export default function MoreScreen() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId } = useCarrierOwner();
  
  const drivers = useQuery(
    api.carrierMobile.getDrivers,
    carrierOrgId ? { carrierOrgId } : 'skip'
  );

  const activeDriverCount = drivers?.filter(d => d.employmentStatus === 'Active').length || 0;

  return (
    <ScrollView 
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + 120 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <Text style={styles.pageTitle}>More</Text>

      {/* Dispatcher Console */}
      <Text style={styles.sectionTitle}>Dispatcher Console</Text>
      <View style={styles.card}>
        <TouchableOpacity 
          style={styles.menuItem}
          onPress={() => router.push('/(app)/owner/drivers')}
        >
          <View style={[styles.iconContainer, { backgroundColor: colors.primary + '20' }]}>
            <Ionicons name="people" size={20} color={colors.primary} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>Manage Drivers</Text>
            <Text style={styles.menuItemSubtitle}>{activeDriverCount} Active Drivers</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
        </TouchableOpacity>

        <View style={styles.divider} />

        <View style={[styles.menuItem, styles.menuItemDisabled]}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <MaterialCommunityIcons name="truck-fast" size={20} color={colors.foregroundMuted} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitleDisabled}>Fleet Overview</Text>
            <Text style={styles.menuItemSubtitle}>Real-time fleet tracking</Text>
          </View>
          <View style={styles.comingSoonBadge}>
            <Text style={styles.comingSoonText}>Coming Soon</Text>
          </View>
        </View>
      </View>

      {/* Operational Settings */}
      <Text style={styles.sectionTitle}>Operational Settings</Text>
      <View style={styles.card}>
        <TouchableOpacity 
          style={styles.menuItem}
          onPress={() => router.push('/(app)/owner/notifications')}
        >
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="notifications" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>Notification Preferences</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
        </TouchableOpacity>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="lock-closed" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>Privacy & Security</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
        </TouchableOpacity>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Feather name="grid" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>Display Mode</Text>
          </View>
          <View style={styles.valueRow}>
            <Text style={styles.menuItemValue}>System Default</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
          </View>
        </TouchableOpacity>
      </View>

      {/* Support */}
      <Text style={styles.sectionTitle}>Support</Text>
      <View style={styles.card}>
        <TouchableOpacity style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="help-circle" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>Help Center</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
        </TouchableOpacity>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.menuItem}>
          <View style={[styles.iconContainer, { backgroundColor: colors.muted }]}>
            <Ionicons name="information-circle" size={20} color={colors.foreground} />
          </View>
          <View style={styles.menuItemContent}>
            <Text style={styles.menuItemTitle}>About Dispatch Pro</Text>
          </View>
          <View style={styles.valueRow}>
            <Text style={styles.menuItemValue}>v2.4.1</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.foregroundMuted} />
          </View>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
  },
  pageTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.md,
    marginTop: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    ...shadows.md,
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
  menuItemDisabled: {
    opacity: 0.7,
  },
  comingSoonBadge: {
    backgroundColor: colors.primary + '20',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  comingSoonText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: colors.primary,
  },
  menuItemSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  menuItemValue: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
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
});
