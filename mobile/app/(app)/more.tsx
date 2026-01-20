import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useUser } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useDriver } from './_layout';

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
  const { user } = useUser();
  const router = useRouter();
  const { driverName, truck } = useDriver();

  // Format truck info for display
  const truckUnit = truck ? `Unit #${truck.unitId}` : 'No truck assigned';
  const truckModel = truck 
    ? [truck.make, truck.model].filter(Boolean).join(' ') || 'Unknown Model'
    : 'Scan a QR code to assign a truck';
  const hasTruck = !!truck;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>More</Text>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Vehicle Details Section */}
        <Text style={styles.sectionTitle}>Vehicle Details</Text>
        <View style={styles.vehicleCard}>
          <View style={styles.vehicleHeader}>
            <View style={styles.vehicleIconContainer}>
              <View style={styles.vehicleIcon}>
                <MaterialCommunityIcons name="truck" size={24} color={colors.primary} />
              </View>
              <View>
                <Text style={styles.vehicleUnit}>{truckUnit}</Text>
                <Text style={styles.vehicleModel}>{truckModel}</Text>
              </View>
            </View>
            {hasTruck && (
              <View style={styles.activeBadge}>
                <Text style={styles.activeBadgeText}>ACTIVE</Text>
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
            <Text style={styles.switchTruckText}>{hasTruck ? 'Switch Truck' : 'Assign Truck'}</Text>
          </TouchableOpacity>
        </View>

        {/* Financials & History Section */}
        <Text style={styles.sectionTitle}>Financials & History</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconGreen]}>
              <Ionicons name="cash" size={20} color={colors.success} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Current Payroll</Text>
              <Text style={styles.menuSubtitle}>Period: May 1 - May 15</Text>
            </View>
            <Text style={styles.menuValueGreen}>$3,240.50</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="receipt" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Past Payroll</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconBlue]}>
              <MaterialCommunityIcons name="truck-delivery" size={20} color="#3b82f6" />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Load History</Text>
            </View>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>128 Total</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>
        </View>

        {/* Compliance & Documents Section */}
        <Text style={styles.sectionTitle}>Compliance & Documents</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconRed]}>
              <Ionicons name="alert-circle" size={20} color={colors.destructive} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Compliance Status</Text>
            </View>
            <View style={styles.alertBadge}>
              <Text style={styles.alertBadgeText}>2 Items Due</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconBlue]}>
              <Ionicons name="ribbon" size={20} color="#3b82f6" />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Required Certifications</Text>
            </View>
            <Text style={styles.menuValueMuted}>Valid Until Dec{'\n'}2025</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuRow}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="document-text" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Inspection Reports</Text>
            </View>
            <Text style={styles.menuValueMuted}>Last: 3 days ago</Text>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconMuted]}>
              <Ionicons name="folder" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Company Policies</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>
        </View>

        {/* Safety & Support Section */}
        <Text style={styles.sectionTitle}>Safety & Support</Text>
        <View style={styles.menuSection}>
          <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]}>
            <View style={[styles.menuIconContainer, styles.menuIconOrange]}>
              <Ionicons name="warning" size={20} color={colors.primary} />
            </View>
            <View style={styles.menuTextContainer}>
              <Text style={styles.menuLabel}>Report an Accident</Text>
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
    fontSize: 28,
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
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },

  // Vehicle Card
  vehicleCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  vehicleHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  vehicleIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  vehicleIcon: {
    width: 48,
    height: 48,
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
    gap: spacing.lg,
    marginBottom: spacing.lg,
    paddingTop: spacing.md,
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
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.lg,
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
    fontWeight: '600',
    color: colors.foreground,
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
