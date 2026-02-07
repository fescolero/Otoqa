import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useDriver } from './_layout';
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
// MORE SCREEN
// Vehicle, Financials, Compliance & Support
// ============================================

export default function MoreScreen() {
  const router = useRouter();
  const { truck } = useDriver();
  const { t } = useLanguage();

  // Format truck info for display
  const truckUnit = truck ? `Unit #${truck.unitId}` : t('more.noTruckAssigned');
  const truckModel = truck 
    ? [truck.make, truck.model].filter(Boolean).join(' ') || 'Unknown Model'
    : t('more.scanQrToAssign');
  const hasTruck = !!truck;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('more.title')}</Text>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Vehicle Details Section */}
        <Text style={styles.sectionTitle}>{t('more.vehicleDetails')}</Text>
        <View style={styles.vehicleCard}>
          <View style={styles.vehicleHeader}>
            <View style={styles.vehicleIconContainer}>
              <View style={styles.vehicleIcon}>
                <MaterialCommunityIcons name="truck" size={20} color={colors.primary} />
              </View>
              <View>
                <Text style={styles.vehicleUnit}>{truckUnit}</Text>
                <Text style={styles.vehicleModel}>{truckModel}</Text>
              </View>
            </View>
            {hasTruck && (
              <View style={styles.activeBadge}>
                <Text style={styles.activeBadgeText} maxFontSizeMultiplier={1.2}>{t('more.active')}</Text>
              </View>
            )}
          </View>

          {hasTruck && (
            <View style={styles.vehicleInfoGrid}>
              <View style={styles.vehicleInfoItem}>
                <Text style={styles.vehicleInfoLabel}>UNIT ID</Text>
                <Text style={styles.vehicleInfoValue}>{truck.unitId}</Text>
              </View>
              <View style={styles.vehicleInfoItem}>
                <Text style={styles.vehicleInfoLabel}>MAKE</Text>
                <Text style={styles.vehicleInfoValue}>{truck.make || '—'}</Text>
              </View>
              <View style={styles.vehicleInfoItem}>
                <Text style={styles.vehicleInfoLabel}>MODEL</Text>
                <Text style={styles.vehicleInfoValue}>{truck.model || '—'}</Text>
              </View>
              <View style={styles.vehicleInfoItem}>
                <Text style={styles.vehicleInfoLabel}>STATUS</Text>
                <Text style={styles.vehicleInfoValue}>Active</Text>
              </View>
            </View>
          )}

          <TouchableOpacity 
            style={styles.switchTruckButton}
            onPress={() => router.push('/switch-truck')}
          >
            <Ionicons name="swap-horizontal" size={18} color={colors.primary} />
            <Text style={styles.switchTruckText}>{hasTruck ? t('more.switchTruck') : t('more.assignTruck')}</Text>
          </TouchableOpacity>
        </View>

        {/* Financials & History Section */}
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>{t('more.financialsHistory')}</Text>
          <View style={styles.comingSoonBadge}>
            <Text style={styles.comingSoonText}>{t('common.comingSoon')}</Text>
          </View>
        </View>
        <View style={[styles.menuSection, styles.menuSectionDisabled]}>
          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="cash" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Current Payroll</Text>
              <Text style={styles.menuSubtitle}>Period: May 1 - May 15</Text>
            </View>
            <Text style={styles.menuValueMuted}>--</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>

          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="receipt" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Past Payroll</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>

          <View style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <MaterialCommunityIcons name="truck-delivery" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Load History</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>
        </View>

        {/* Compliance & Documents Section */}
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>{t('more.complianceDocuments')}</Text>
          <View style={styles.comingSoonBadge}>
            <Text style={styles.comingSoonText}>{t('common.comingSoon')}</Text>
          </View>
        </View>
        <View style={[styles.menuSection, styles.menuSectionDisabled]}>
          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="alert-circle" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Compliance Status</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>

          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="ribbon" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Required Certifications</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>

          <View style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="document-text" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Inspection Reports</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>

          <View style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="folder" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabelDisabled}>Company Policies</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>
        </View>

        {/* Safety & Support Section */}
        <Text style={styles.sectionTitle}>{t('more.safetySupport')}</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconOrange]}>
              <Ionicons name="warning" size={20} color={colors.primary} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>{t('more.reportAccident')}</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>
        </View>

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
  header: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.foreground,
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  comingSoonBadge: {
    backgroundColor: `${colors.primary}20`,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.md,
  },
  comingSoonText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.primary,
  },

  // Vehicle Card
  vehicleCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    padding: spacing.md,
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  vehicleHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  vehicleIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  vehicleIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehicleUnit: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.foreground,
  },
  vehicleModel: {
    fontSize: 14,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  activeBadge: {
    backgroundColor: `${colors.success}25`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
  },
  activeBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.success,
    letterSpacing: 0.5,
  },
  vehicleInfoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: `${colors.border}30`,
  },
  vehicleInfoItem: {
    width: '45%',
  },
  vehicleInfoLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  vehicleInfoValue: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  switchTruckButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    marginHorizontal: -spacing.md,
    marginBottom: -spacing.md,
    borderTopWidth: 1,
    borderTopColor: `${colors.border}30`,
  },
  switchTruckText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },

  // Menu Section
  menuSection: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  menuSectionDisabled: {
    opacity: 0.6,
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
  menuIconGreen: {
    backgroundColor: `${colors.success}20`,
  },
  menuIconBlue: {
    backgroundColor: '#3b82f620',
  },
  menuIconRed: {
    backgroundColor: `${colors.destructive}20`,
  },
  menuIconOrange: {
    backgroundColor: `${colors.primary}20`,
  },
  menuIconMuted: {
    backgroundColor: `${colors.muted}80`,
  },
  menuTextContainer: {
    flex: 1,
  },
  menuLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.foreground,
  },
  menuLabelDisabled: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.foregroundMuted,
  },
  menuSubtitle: {
    fontSize: 13,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  menuValueGreen: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.success,
    marginRight: spacing.sm,
  },
  menuValueMuted: {
    fontSize: 13,
    color: colors.foregroundMuted,
    textAlign: 'right',
    marginRight: spacing.sm,
  },
  countBadge: {
    backgroundColor: `${colors.muted}80`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
    marginRight: spacing.sm,
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.foreground,
  },
  alertBadge: {
    backgroundColor: `${colors.destructive}20`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
    marginRight: spacing.sm,
  },
  alertBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.destructive,
  },
});
