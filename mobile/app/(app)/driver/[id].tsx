import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Id } from '../../../../convex/_generated/dataModel';
import { colors, typography, borderRadius, spacing } from '../../../lib/theme';
import { Ionicons } from '@expo/vector-icons';

// ============================================
// DRIVER DETAIL PAGE
// View detailed driver profile information
// ============================================

export default function DriverDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Fetch driver details
  const driver = useQuery(
    api.carrierMobile.getDriverById,
    id ? { driverId: id as Id<'drivers'> } : 'skip'
  );

  const handleCall = (phone: string) => {
    Linking.openURL(`tel:${phone}`);
  };

  const handleEmail = (email: string) => {
    Linking.openURL(`mailto:${email}`);
  };

  const handleEdit = () => {
    router.push({
      pathname: '/(app)/driver/edit',
      params: { id },
    });
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Not provided';
    const m = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return `${months[parseInt(m[2],10)-1]} ${parseInt(m[3],10)}, ${m[1]}`;
    }
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return 'Not provided';
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return 'Not provided';
    }
  };

  // Get status color
  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'Active':
        return colors.success;
      case 'Suspended':
        return colors.warning;
      case 'Terminated':
        return colors.error;
      default:
        return colors.foregroundMuted;
    }
  };

  // Get state full name
  const getStateName = (stateCode?: string) => {
    if (!stateCode || stateCode === 'N/A') return 'Not provided';
    const states: Record<string, string> = {
      AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
      CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
      HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
      KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
      MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
      MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
      NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
      OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
      SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
      VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    };
    return `${states[stateCode] || stateCode} (${stateCode})`;
  };

  if (!driver) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading driver details...</Text>
      </View>
    );
  }

  const fullName = [driver.firstName, driver.middleName, driver.lastName]
    .filter(Boolean)
    .join(' ');

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </Pressable>
          <Text style={styles.headerTitle}>Driver Profile</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Driver Name & Status */}
        <View style={styles.profileHeader}>
          <Text style={styles.driverName}>{fullName}</Text>
          <View style={[styles.statusBadge, { borderColor: getStatusColor(driver.employmentStatus) }]}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(driver.employmentStatus) }]} />
            <Text style={[styles.statusText, { color: getStatusColor(driver.employmentStatus) }]}>
              {driver.employmentStatus || 'Unknown'} Status
            </Text>
          </View>
        </View>

        {/* Personal Information Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="person" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>PERSONAL INFORMATION</Text>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>FULL NAME</Text>
              <Text style={styles.infoValue}>{fullName}</Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>DATE OF BIRTH</Text>
              <Text style={styles.infoValue}>{formatDate(driver.dateOfBirth) || 'Not provided'}</Text>
            </View>
          </View>
        </View>

        {/* License Details Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="card" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>LICENSE DETAILS</Text>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Text style={styles.hashIcon}>#</Text>
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>LICENSE NUMBER</Text>
              <Text style={styles.infoValue}>{driver.licenseNumber || 'Not provided'}</Text>
            </View>
          </View>

          <View style={styles.infoRowDouble}>
            <View style={styles.infoHalf}>
              <View style={styles.infoIcon}>
                <Ionicons name="person-circle-outline" size={20} color={colors.foregroundMuted} />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>CLASS</Text>
                <Text style={styles.infoValue}>{driver.licenseClass || 'Not provided'}</Text>
              </View>
            </View>
            <View style={styles.infoHalf}>
              <View style={styles.infoIcon}>
                <Ionicons name="location-outline" size={20} color={colors.foregroundMuted} />
              </View>
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>STATE</Text>
                <Text style={[styles.infoValue, { color: colors.primary }]}>
                  {getStateName(driver.licenseState)}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>EXPIRATION DATE</Text>
              <Text style={styles.infoValue}>{formatDate(driver.licenseExpiration)}</Text>
            </View>
          </View>
        </View>

        {/* Contact Details Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="call" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>CONTACT DETAILS</Text>
          </View>

          <View style={styles.infoRowWithAction}>
            <View style={styles.infoIcon}>
              <Ionicons name="call-outline" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.infoContentFlex}>
              <Text style={styles.infoLabel}>PHONE NUMBER</Text>
              <Text style={styles.infoValue}>{driver.phone || 'Not provided'}</Text>
            </View>
            {driver.phone && (
              <Pressable
                style={styles.actionButton}
                onPress={() => handleCall(driver.phone)}
              >
                <Ionicons name="call" size={20} color={colors.primary} />
              </Pressable>
            )}
          </View>

          <View style={styles.infoRowWithAction}>
            <View style={styles.infoIcon}>
              <Ionicons name="mail-outline" size={20} color={colors.foregroundMuted} />
            </View>
            <View style={styles.infoContentFlex}>
              <Text style={styles.infoLabel}>EMAIL ADDRESS</Text>
              <Text style={styles.infoValue}>{driver.email || 'Not provided'}</Text>
            </View>
            {driver.email && (
              <Pressable
                style={styles.actionButton}
                onPress={() => handleEmail(driver.email)}
              >
                <Ionicons name="mail" size={20} color={colors.primary} />
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Edit Button */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable style={styles.editButton} onPress={handleEdit}>
          <Ionicons name="pencil" size={20} color={colors.primaryForeground} />
          <Text style={styles.editButtonText}>Edit Driver</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: spacing.md,
    fontSize: typography.md,
    color: colors.foregroundMuted,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    backgroundColor: colors.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: typography.lg,
    fontWeight: typography.semibold as any,
    color: colors.foreground,
  },
  headerSpacer: {
    width: 40,
  },
  profileHeader: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  driverName: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold as any,
    color: colors.foreground,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  statusText: {
    fontSize: typography.sm,
    fontWeight: typography.medium as any,
  },
  section: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold as any,
    color: colors.primary,
    letterSpacing: 1,
    marginLeft: spacing.sm,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  infoRowDouble: {
    flexDirection: 'row',
    paddingVertical: spacing.md,
  },
  infoHalf: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  infoRowWithAction: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    backgroundColor: colors.muted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  hashIcon: {
    fontSize: typography.lg,
    fontWeight: typography.bold as any,
    color: colors.foregroundMuted,
  },
  infoContent: {
    flex: 1,
  },
  infoContentFlex: {
    flex: 1,
  },
  infoLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium as any,
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  infoValue: {
    fontSize: typography.md,
    fontWeight: typography.medium as any,
    color: colors.foreground,
  },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
  },
  editButtonText: {
    fontSize: typography.md,
    fontWeight: typography.semibold as any,
    color: colors.primaryForeground,
  },
});
