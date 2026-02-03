import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../../lib/theme';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Id } from '../../../../../convex/_generated/dataModel';

// ============================================
// LOAD DETAIL SCREEN (Carrier View)
// Full load info with driver assignment
// ============================================

export default function LoadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { carrierOrgId } = useCarrierOwner();
  const router = useRouter();
  const [showDriverPicker, setShowDriverPicker] = useState(false);

  const assignment = useQuery(
    api.loadCarrierAssignments.get,
    id ? { assignmentId: id as Id<'loadCarrierAssignments'> } : 'skip'
  );

  const availableDrivers = useQuery(
    api.carrierMobile.getAvailableDrivers,
    carrierOrgId ? { carrierOrgId } : 'skip'
  );

  const assignDriver = useMutation(api.loadCarrierAssignments.assignDriver);
  const startLoad = useMutation(api.loadCarrierAssignments.startLoad);
  const completeLoad = useMutation(api.loadCarrierAssignments.completeLoad);
  const cancelAssignment = useMutation(api.loadCarrierAssignments.cancelAssignment);

  if (!assignment) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading load details...</Text>
      </View>
    );
  }

  const handleAssignDriver = async (driver: { _id: string; firstName: string; lastName: string; phone?: string }) => {
    if (!carrierOrgId) return;
    try {
      await assignDriver({
        assignmentId: id as Id<'loadCarrierAssignments'>,
        carrierOrgId,
        driverId: driver._id as Id<'drivers'>,
        driverName: `${driver.firstName} ${driver.lastName}`,
        driverPhone: driver.phone,
      });
      setShowDriverPicker(false);
    } catch (error) {
      Alert.alert('Error', 'Failed to assign driver');
    }
  };

  const handleStartLoad = async () => {
    if (!carrierOrgId) return;
    try {
      await startLoad({
        assignmentId: id as Id<'loadCarrierAssignments'>,
        carrierOrgId,
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to start load');
    }
  };

  const handleCompleteLoad = async () => {
    if (!carrierOrgId) return;
    Alert.alert(
      'Complete Load',
      'Mark this load as delivered?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Complete',
          onPress: async () => {
            try {
              await completeLoad({
                assignmentId: id as Id<'loadCarrierAssignments'>,
                carrierOrgId,
              });
              router.back();
            } catch (error) {
              Alert.alert('Error', 'Failed to complete load');
            }
          },
        },
      ]
    );
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel Load',
      'Are you sure you want to cancel this load?',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelAssignment({
                assignmentId: id as Id<'loadCarrierAssignments'>,
                canceledBy: carrierOrgId || '',
                canceledByParty: 'CARRIER',
                cancellationReason: 'OTHER',
              });
              router.back();
            } catch (error) {
              Alert.alert('Error', 'Failed to cancel load');
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Rate Card */}
      <View style={styles.rateCard}>
        <Text style={styles.rateLabel}>Your Rate</Text>
        <Text style={styles.rateAmount}>
          ${assignment.carrierTotalAmount?.toLocaleString()}
        </Text>
        <View style={styles.rateBreakdown}>
          <Text style={styles.breakdownText}>
            Base: ${assignment.carrierRate?.toLocaleString()}
          </Text>
          {assignment.carrierFuelSurcharge && (
            <Text style={styles.breakdownText}>
              FSC: ${assignment.carrierFuelSurcharge?.toLocaleString()}
            </Text>
          )}
        </View>
      </View>

      {/* Status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Status</Text>
        <View style={[styles.statusBadge, getStatusStyle(assignment.status)]}>
          <Text style={styles.statusText}>{formatStatus(assignment.status)}</Text>
        </View>
      </View>

      {/* Driver Assignment */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assigned Driver</Text>
        {assignment.assignedDriverName ? (
          <View style={styles.driverCard}>
            <Ionicons name="person-circle" size={40} color={colors.primary} />
            <View style={styles.driverInfo}>
              <Text style={styles.driverName}>{assignment.assignedDriverName}</Text>
              {assignment.assignedDriverPhone && (
                <Text style={styles.driverPhone}>{assignment.assignedDriverPhone}</Text>
              )}
            </View>
            {(assignment.status === 'AWARDED' || assignment.status === 'ACCEPTED') && (
              <TouchableOpacity
                style={styles.changeButton}
                onPress={() => setShowDriverPicker(true)}
              >
                <Text style={styles.changeButtonText}>Change</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <TouchableOpacity
            style={styles.assignDriverButton}
            onPress={() => setShowDriverPicker(true)}
            disabled={assignment.status !== 'AWARDED' && assignment.status !== 'ACCEPTED'}
          >
            <Ionicons name="person-add" size={24} color={colors.primary} />
            <Text style={styles.assignDriverText}>Assign Driver</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Driver Picker Modal */}
      {showDriverPicker && (
        <View style={styles.driverPicker}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Select Driver</Text>
            <TouchableOpacity onPress={() => setShowDriverPicker(false)}>
              <Ionicons name="close" size={24} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          {availableDrivers?.map((driver) => (
            <TouchableOpacity
              key={driver._id}
              style={styles.driverOption}
              onPress={() => handleAssignDriver(driver)}
            >
              <Ionicons name="person" size={20} color={colors.foreground} />
              <Text style={styles.driverOptionText}>
                {driver.firstName} {driver.lastName}
              </Text>
            </TouchableOpacity>
          ))}
          {availableDrivers?.length === 0 && (
            <Text style={styles.noDriversText}>No available drivers</Text>
          )}
        </View>
      )}

      {/* Payment Status */}
      {assignment.paymentStatus && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment</Text>
          <View style={styles.paymentCard}>
            <View style={styles.paymentRow}>
              <Text style={styles.paymentLabel}>Status</Text>
              <Text style={styles.paymentValue}>{assignment.paymentStatus}</Text>
            </View>
            {assignment.paymentDate && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Paid</Text>
                <Text style={styles.paymentValue}>
                  {new Date(assignment.paymentDate).toLocaleDateString()}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Action Buttons */}
      <View style={styles.actions}>
        {assignment.status === 'AWARDED' && assignment.assignedDriverId && (
          <TouchableOpacity style={styles.primaryButton} onPress={handleStartLoad}>
            <Ionicons name="play" size={20} color={colors.foreground} />
            <Text style={styles.primaryButtonText}>Start Load</Text>
          </TouchableOpacity>
        )}

        {assignment.status === 'IN_PROGRESS' && (
          <TouchableOpacity style={styles.successButton} onPress={handleCompleteLoad}>
            <Ionicons name="checkmark-circle" size={20} color={colors.foreground} />
            <Text style={styles.successButtonText}>Mark Delivered</Text>
          </TouchableOpacity>
        )}

        {(assignment.status === 'AWARDED' || assignment.status === 'IN_PROGRESS') && (
          <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
            <Text style={styles.cancelButtonText}>Cancel Load</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom Padding */}
      <View style={{ height: 120 }} />
    </ScrollView>
  );
}

function formatStatus(status: string) {
  const statusMap: Record<string, string> = {
    OFFERED: 'Offered',
    ACCEPTED: 'Accepted',
    AWARDED: 'Ready to Start',
    IN_PROGRESS: 'In Transit',
    COMPLETED: 'Delivered',
    DECLINED: 'Declined',
    CANCELED: 'Canceled',
  };
  return statusMap[status] || status;
}

function getStatusStyle(status: string) {
  switch (status) {
    case 'AWARDED':
      return { backgroundColor: colors.success + '20' };
    case 'IN_PROGRESS':
      return { backgroundColor: colors.warning + '20' };
    case 'COMPLETED':
      return { backgroundColor: colors.success + '30' };
    default:
      return { backgroundColor: colors.muted };
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: colors.foregroundMuted,
  },
  rateCard: {
    backgroundColor: colors.primary + '20',
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  rateLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  rateAmount: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.success,
    marginVertical: spacing.sm,
  },
  rateBreakdown: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  breakdownText: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
  },
  statusText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  driverCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    ...shadows.sm,
  },
  driverInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  driverName: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  driverPhone: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  changeButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.muted,
    borderRadius: borderRadius.md,
  },
  changeButtonText: {
    fontSize: typography.sm,
    color: colors.foreground,
    fontWeight: '500',
  },
  assignDriverButton: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  assignDriverText: {
    fontSize: typography.base,
    color: colors.primary,
    fontWeight: '600',
  },
  driverPicker: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadows.md,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  driverOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  driverOptionText: {
    fontSize: typography.base,
    color: colors.foreground,
  },
  noDriversText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  paymentCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    ...shadows.sm,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  paymentLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  paymentValue: {
    fontSize: typography.sm,
    color: colors.foreground,
    fontWeight: '500',
  },
  actions: {
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primaryButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  successButton: {
    backgroundColor: colors.success,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  successButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  cancelButton: {
    backgroundColor: 'transparent',
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.destructive,
  },
  cancelButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.destructive,
  },
});
