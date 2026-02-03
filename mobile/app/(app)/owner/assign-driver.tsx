import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Id } from '../../../../convex/_generated/dataModel';

// ============================================
// ASSIGN DRIVER PAGE
// Select and assign a driver to a load
// ============================================

interface DriverOption {
  _id: Id<'drivers'>;
  name: string;
  firstName: string;
  lastName: string;
  phone: string;
  truckId: string;
  status: 'ONLINE' | 'OFFLINE';
}

export default function AssignDriverScreen() {
  const insets = useSafeAreaInsets();
  const { assignmentId, loadInternalId } = useLocalSearchParams<{ 
    assignmentId: string; 
    loadInternalId: string;
  }>();
  const { carrierOrgId } = useCarrierOwner();
  const [selectedDriverId, setSelectedDriverId] = useState<Id<'drivers'> | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);

  // Debug: Log params on mount
  console.log('[AssignDriver] Page loaded with params:', { assignmentId, loadInternalId, carrierOrgId });

  // Check if assignmentId looks like a valid Convex ID (not "demo")
  const isValidAssignmentId = assignmentId && assignmentId !== 'demo' && assignmentId.length > 10;

  // Get the assignment details with load and stops
  const assignment = useQuery(
    api.loadCarrierAssignments.getWithDetails,
    isValidAssignmentId ? { assignmentId: assignmentId as Id<'loadCarrierAssignments'> } : 'skip'
  );

  console.log('[AssignDriver] Assignment query result:', assignment);

  // Get available drivers (not on active loads)
  const drivers = useQuery(
    api.carrierMobile.getDrivers,
    carrierOrgId ? { carrierOrgId } : 'skip'
  );

  // Assign driver mutation
  const assignDriverMutation = useMutation(api.loadCarrierAssignments.assignDriver);

  // Helper to format date strings
  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return 'TBD';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  // Helper to format time strings
  const formatTime = (timeStr: string | undefined) => {
    if (!timeStr) return '';
    try {
      const date = new Date(timeStr);
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch {
      return timeStr;
    }
  };

  // Helper to format phone numbers as (XXX) XXX-XXXX
  const formatPhoneNumber = (phone: string | undefined) => {
    if (!phone) return 'No phone';
    // Remove all non-digits
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length === 11 && digits[0] === '1') {
      return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone; // Return original if can't format
  };

  // Transform drivers for display - only show available drivers
  const availableDrivers: DriverOption[] = drivers?.map((driver) => {
    const hasCurrentAssignment = !!driver.currentAssignment;
    
    return {
      _id: driver._id as Id<'drivers'>,
      name: `${driver.firstName} ${driver.lastName}`,
      firstName: driver.firstName,
      lastName: driver.lastName,
      phone: driver.phone,
      truckId: driver.currentTruckId || 'N/A',
      status: hasCurrentAssignment ? 'OFFLINE' as const : 'ONLINE' as const,
    };
  }).filter(d => d.status !== 'OFFLINE') || [];

  // Load data from assignment with real values
  const loadData = {
    internalId: assignment?.load?.internalId || loadInternalId || 'N/A',
    pickup: {
      city: assignment?.pickup?.city || 'Unknown',
      state: assignment?.pickup?.state || '',
      date: formatDate(assignment?.pickup?.date),
      time: formatTime(assignment?.pickup?.time),
    },
    delivery: {
      city: assignment?.delivery?.city || 'Unknown',
      state: assignment?.delivery?.state || '',
      date: formatDate(assignment?.delivery?.date),
      time: formatTime(assignment?.delivery?.time),
    },
    weight: assignment?.load?.weight 
      ? `${assignment.load.weight.toLocaleString()} ${assignment.load.units || 'lbs'}`
      : 'N/A',
    distance: assignment?.load?.effectiveMiles 
      ? `${assignment.load.effectiveMiles.toLocaleString()} miles`
      : 'N/A',
    payout: assignment?.carrierTotalAmount || 0,
  };

  const selectedDriver = availableDrivers.find(d => d._id === selectedDriverId);

  const handleConfirmAssignment = async () => {
    console.log('[AssignDriver] handleConfirmAssignment called');
    console.log('[AssignDriver] selectedDriverId:', selectedDriverId);
    console.log('[AssignDriver] assignmentId:', assignmentId);
    console.log('[AssignDriver] selectedDriver:', selectedDriver?.name);
    console.log('[AssignDriver] assignment:', assignment);
    console.log('[AssignDriver] assignment?.carrierOrgId:', assignment?.carrierOrgId);

    if (!selectedDriverId || !assignmentId || !selectedDriver) {
      console.log('[AssignDriver] Missing required data - showing alert');
      Alert.alert('Error', 'Please select a driver');
      return;
    }

    if (!assignment?.carrierOrgId) {
      console.log('[AssignDriver] No carrierOrgId - showing alert');
      Alert.alert('Error', 'Assignment data not loaded yet');
      return;
    }
    
    setIsAssigning(true);
    
    try {
      console.log('[AssignDriver] Calling mutation with:', {
        assignmentId,
        carrierOrgId: assignment.carrierOrgId,
        driverId: selectedDriverId,
        driverName: selectedDriver.name,
        driverPhone: selectedDriver.phone,
      });

      // Use the carrierOrgId from the assignment itself to ensure it matches
      await assignDriverMutation({
        assignmentId: assignmentId as Id<'loadCarrierAssignments'>,
        carrierOrgId: assignment.carrierOrgId,
        driverId: selectedDriverId,
        driverName: selectedDriver.name,
        driverPhone: selectedDriver.phone,
      });
      
      console.log('[AssignDriver] Mutation successful!');
      Alert.alert(
        'Success',
        `${selectedDriver.name} has been assigned to this load.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (error) {
      console.error('[AssignDriver] Failed to assign driver:', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to assign driver. Please try again.'
      );
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Assign Driver</Text>
          <Text style={styles.headerSubtitle}>LOAD #{loadData.internalId}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView 
        style={styles.content}
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Load Overview Card */}
        <View style={styles.loadCard}>
          <View style={styles.loadCardHeader}>
            <View style={styles.loadIconRow}>
              <View style={styles.loadIcon}>
                <MaterialCommunityIcons name="cube-outline" size={20} color={colors.primary} />
              </View>
              <Text style={styles.loadOverviewTitle}>Load Overview</Text>
            </View>
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingBadgeText}>PENDING ASSIGNMENT</Text>
            </View>
          </View>

          {/* Pickup */}
          <View style={styles.stopRow}>
            <View style={styles.stopDot} />
            <View style={styles.stopInfo}>
              <Text style={styles.stopLabel}>PICKUP</Text>
              <Text style={styles.stopValue}>
                {loadData.pickup.city}, {loadData.pickup.state} • {loadData.pickup.date}, {loadData.pickup.time}
              </Text>
            </View>
          </View>

          {/* Delivery */}
          <View style={styles.stopRow}>
            <View style={[styles.stopDot, styles.deliveryDot]} />
            <View style={styles.stopInfo}>
              <Text style={styles.stopLabel}>DELIVERY</Text>
              <Text style={styles.stopValue}>
                {loadData.delivery.city}, {loadData.delivery.state} • {loadData.delivery.date}, {loadData.delivery.time}
              </Text>
            </View>
          </View>

          {/* Weight & Distance */}
          <View style={styles.metricsRow}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>WEIGHT</Text>
              <Text style={styles.metricValue}>{loadData.weight}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>DISTANCE</Text>
              <Text style={styles.metricValue}>{loadData.distance}</Text>
            </View>
          </View>
        </View>

        {/* Available Drivers Section */}
        <View style={styles.driversSection}>
          <View style={styles.driversSectionHeader}>
            <Text style={styles.driversSectionTitle}>Available Drivers</Text>
          </View>

          {availableDrivers.length > 0 ? (
            availableDrivers.map((driver) => (
              <TouchableOpacity
                key={driver._id}
                style={[
                  styles.driverCard,
                  selectedDriverId === driver._id && styles.driverCardSelected,
                ]}
                onPress={() => setSelectedDriverId(driver._id)}
                activeOpacity={0.7}
              >
                {/* Driver Info */}
                <View style={styles.driverInfo}>
                  <View style={styles.driverNameRow}>
                    <Text style={styles.driverName}>{driver.name}</Text>
                    <View style={styles.statusBadge}>
                      <Text style={styles.statusBadgeText}>Available</Text>
                    </View>
                  </View>
                  {driver.truckId !== 'N/A' && (
                    <Text style={styles.driverTruck}>Truck: {driver.truckId}</Text>
                  )}
                  <Text style={styles.driverPhone}>{formatPhoneNumber(driver.phone)}</Text>
                </View>

                {/* Selection Indicator */}
                {selectedDriverId === driver._id && (
                  <View style={styles.checkIcon}>
                    <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                  </View>
                )}
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="person-outline" size={48} color={colors.foregroundMuted} />
              <Text style={styles.emptyTitle}>No Available Drivers</Text>
              <Text style={styles.emptyDesc}>All drivers are currently on assignment or offline.</Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Bottom Action Bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.selectedInfo}>
          <Text style={styles.selectedLabel}>SELECTED DRIVER</Text>
          <Text style={styles.selectedValue}>
            {selectedDriver ? selectedDriver.name : 'None'}
          </Text>
        </View>
        <View style={styles.payoutInfo}>
          <Text style={styles.payoutLabelDisabled}>EST. PAYOUT</Text>
          <Text style={styles.payoutValueDisabled}>--</Text>
        </View>
      </View>

      <View style={[styles.confirmButtonContainer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <TouchableOpacity
          style={[
            styles.confirmButton,
            !selectedDriverId && styles.confirmButtonDisabled,
          ]}
          onPress={handleConfirmAssignment}
          disabled={!selectedDriverId || isAssigning}
        >
          {isAssigning ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <>
              <View style={styles.confirmDot} />
              <Text style={styles.confirmButtonText}>Confirm Assignment</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    padding: spacing.xs,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  headerSubtitle: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  headerSpacer: {
    width: 32,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },

  // Load Card
  loadCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    ...shadows.md,
  },
  loadCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  loadIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.primary + '20',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadOverviewTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  pendingBadge: {
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  pendingBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primaryForeground,
    letterSpacing: 0.5,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  stopDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4CAF50',
    marginTop: 4,
    marginRight: spacing.md,
  },
  deliveryDot: {
    backgroundColor: colors.primary,
  },
  stopInfo: {
    flex: 1,
  },
  stopLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  stopValue: {
    fontSize: typography.base,
    fontWeight: '500',
    color: colors.foreground,
  },
  metricsRow: {
    flexDirection: 'row',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: typography.lg,
    fontWeight: '700',
    color: colors.foreground,
  },

  // Drivers Section
  driversSection: {
    marginBottom: spacing.xl,
  },
  driversSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  driversSectionTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },

  // Driver Card
  driverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 2,
    borderColor: 'transparent',
    ...shadows.sm,
  },
  driverCardSelected: {
    borderColor: colors.primary,
  },
  driverInfo: {
    flex: 1,
  },
  driverNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  driverName: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    backgroundColor: '#4CAF50',
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  driverTruck: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  driverPhone: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  checkIcon: {
    marginLeft: spacing.sm,
  },

  // Empty State
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.md,
  },
  emptyDesc: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
  },

  // Bottom Bar
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  selectedInfo: {},
  selectedLabel: {
    fontSize: 10,
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  selectedValue: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: 2,
  },
  payoutInfo: {
    alignItems: 'flex-end',
  },
  payoutLabelDisabled: {
    fontSize: 10,
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
    opacity: 0.5,
  },
  payoutValueDisabled: {
    fontSize: typography.lg,
    fontWeight: '700',
    color: colors.foregroundMuted,
    marginTop: 2,
    opacity: 0.5,
  },

  // Confirm Button
  confirmButtonContainer: {
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  confirmButtonDisabled: {
    opacity: 0.5,
  },
  confirmDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.background,
  },
  confirmButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.background,
  },
});
