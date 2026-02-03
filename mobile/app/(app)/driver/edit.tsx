import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { useState, useEffect } from 'react';
import { api } from '../../../../convex/_generated/api';
import { Id } from '../../../../convex/_generated/dataModel';
import { colors, typography, borderRadius, spacing } from '../../../lib/theme';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import DatePickerModal from '../../../components/DatePickerModal';

// ============================================
// EDIT DRIVER PAGE
// Edit existing driver profile
// ============================================

type EmploymentStatus = 'Active' | 'Suspended' | 'Terminated';

interface EditDriverForm {
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  licenseNumber: string;
  licenseClass: string;
  licenseState: string;
  licenseExpiration: string;
  phone: string;
  email: string;
  notes: string;
  employmentStatus: EmploymentStatus;
}

export default function EditDriverScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [isUpdating, setIsUpdating] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showLicenseExpirationPicker, setShowLicenseExpirationPicker] = useState(false);
  const [showLicenseClassPicker, setShowLicenseClassPicker] = useState(false);
  const [dateOfBirth, setDateOfBirth] = useState<Date | null>(null);
  const [licenseExpirationDate, setLicenseExpirationDate] = useState<Date | null>(null);

  const LICENSE_CLASSES = ['Class A', 'Class B', 'Class C'] as const;
  const [formData, setFormData] = useState<EditDriverForm>({
    firstName: '',
    middleName: '',
    lastName: '',
    dateOfBirth: '',
    licenseNumber: '',
    licenseClass: '',
    licenseState: '',
    licenseExpiration: '',
    phone: '',
    email: '',
    notes: '',
    employmentStatus: 'Active',
  });

  // Fetch driver details
  const driver = useQuery(
    api.carrierMobile.getDriverById,
    id ? { driverId: id as Id<'drivers'> } : 'skip'
  );

  // Update mutation
  const updateDriverMutation = useMutation(api.carrierMobile.updateDriver);

  // Populate form when driver data loads
  useEffect(() => {
    if (driver) {
      const dob = (driver as any).dateOfBirth;
      if (dob) {
        // Try to parse the date
        const parsedDate = new Date(dob);
        if (!isNaN(parsedDate.getTime())) {
          setDateOfBirth(parsedDate);
        }
      }
      
      // Parse license expiration date
      const licExp = driver.licenseExpiration;
      if (licExp) {
        const parsedLicExp = new Date(licExp);
        if (!isNaN(parsedLicExp.getTime())) {
          setLicenseExpirationDate(parsedLicExp);
        }
      }
      
      setFormData({
        firstName: driver.firstName || '',
        middleName: driver.middleName || '',
        lastName: driver.lastName || '',
        dateOfBirth: dob || '',
        licenseNumber: (driver as any).licenseNumber || '',
        licenseClass: driver.licenseClass || '',
        licenseState: driver.licenseState || '',
        licenseExpiration: driver.licenseExpiration || '',
        phone: driver.phone || '',
        email: driver.email || '',
        notes: '',
        employmentStatus: (driver.employmentStatus as EmploymentStatus) || 'Active',
      });
    }
  }, [driver]);

  // Format date for display
  const formatDateDisplay = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleUpdate = async () => {
    if (!formData.firstName.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s first name.');
      return;
    }
    if (!formData.lastName.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s last name.');
      return;
    }
    if (!formData.phone.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s phone number.');
      return;
    }
    if (!id || !driver?.organizationId) {
      Alert.alert('Error', 'Driver information not found. Please try again.');
      return;
    }

    setIsUpdating(true);

    try {
      // #region agent log
      console.log('[DEBUG] Updating driver with:', {
        driverId: id,
        dateOfBirth: formData.dateOfBirth,
        licenseNumber: formData.licenseNumber,
        middleName: formData.middleName,
      });
      // #endregion
      const result = await updateDriverMutation({
        driverId: id as Id<'drivers'>,
        carrierOrgId: driver.organizationId,
        firstName: formData.firstName.trim(),
        middleName: formData.middleName.trim() || undefined,
        lastName: formData.lastName.trim(),
        email: formData.email.trim() || undefined,
        phone: formData.phone.trim(),
        dateOfBirth: formData.dateOfBirth.trim() || undefined,
        licenseNumber: formData.licenseNumber.trim() || undefined,
        licenseState: formData.licenseState.trim() || undefined,
        licenseClass: formData.licenseClass.trim() || undefined,
        licenseExpiration: formData.licenseExpiration.trim() || undefined,
        employmentStatus: formData.employmentStatus,
      });

      if (result.success) {
        Alert.alert(
          'Driver Updated',
          `${formData.firstName} ${formData.lastName}'s profile has been updated.`,
          [{ text: 'OK', onPress: () => router.back() }]
        );
      }
    } catch (error: any) {
      console.error('Error updating driver:', error);
      Alert.alert(
        'Error',
        error.message || 'Failed to update driver. Please try again.'
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const resetForm = () => {
    if (driver) {
      setFormData({
        firstName: driver.firstName || '',
        middleName: driver.middleName || '',
        lastName: driver.lastName || '',
        dateOfBirth: (driver as any).dateOfBirth || '',
        licenseNumber: (driver as any).licenseNumber || '',
        licenseClass: driver.licenseClass || '',
        licenseState: driver.licenseState || '',
        licenseExpiration: driver.licenseExpiration || '',
        phone: driver.phone || '',
        email: driver.email || '',
        notes: '',
        employmentStatus: (driver.employmentStatus as EmploymentStatus) || 'Active',
      });
    }
  };

  if (!driver) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading driver details...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Edit Driver</Text>
          <TouchableOpacity onPress={resetForm}>
            <Text style={styles.resetText}>Reset</Text>
          </TouchableOpacity>
        </View>

        <ScrollView 
          style={styles.content} 
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        >
          {/* Employment Status */}
          <Text style={styles.fieldLabel}>Employment Status</Text>
          <View style={styles.statusSelector}>
            {(['Active', 'Suspended', 'Terminated'] as EmploymentStatus[]).map((status) => (
              <TouchableOpacity
                key={status}
                style={[
                  styles.statusOption,
                  formData.employmentStatus === status && styles.activeStatusOption,
                ]}
                onPress={() => setFormData(prev => ({ ...prev, employmentStatus: status }))}
              >
                <View style={[
                  styles.statusOptionDot,
                  { backgroundColor: status === 'Active' ? '#4CAF50' : status === 'Suspended' ? colors.warning : '#FF6B6B' }
                ]} />
                <Text style={[
                  styles.statusOptionText,
                  formData.employmentStatus === status && styles.activeStatusOptionText
                ]}>
                  {status}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Personal Information Section */}
          <View style={styles.sectionHeader}>
            <Ionicons name="person" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>PERSONAL INFORMATION</Text>
          </View>

          <Text style={styles.fieldLabel}>First Name</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="John"
              placeholderTextColor={colors.foregroundMuted}
              value={formData.firstName}
              onChangeText={(text) => setFormData(prev => ({ ...prev, firstName: text }))}
            />
          </View>

          <Text style={styles.fieldLabel}>Middle Name (Optional)</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="Michael"
              placeholderTextColor={colors.foregroundMuted}
              value={formData.middleName}
              onChangeText={(text) => setFormData(prev => ({ ...prev, middleName: text }))}
            />
          </View>

          <Text style={styles.fieldLabel}>Last Name</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="Doe"
              placeholderTextColor={colors.foregroundMuted}
              value={formData.lastName}
              onChangeText={(text) => setFormData(prev => ({ ...prev, lastName: text }))}
            />
          </View>

          <Text style={styles.fieldLabel}>Date of Birth</Text>
          <TouchableOpacity 
            style={styles.inputContainer}
            onPress={() => setShowDatePicker(true)}
          >
            <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            <Text style={[
              styles.dateText,
              !dateOfBirth && styles.datePlaceholder
            ]}>
              {dateOfBirth ? formatDateDisplay(dateOfBirth) : 'Select date of birth'}
            </Text>
            <Ionicons name="chevron-down" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          {/* License Information Section */}
          <View style={styles.sectionHeader}>
            <Ionicons name="card" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>LICENSE INFORMATION</Text>
          </View>

          <Text style={styles.fieldLabel}>License Number</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="card-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="DL123456789"
              placeholderTextColor={colors.foregroundMuted}
              value={formData.licenseNumber}
              onChangeText={(text) => setFormData(prev => ({ ...prev, licenseNumber: text }))}
            />
          </View>

          <View style={styles.rowInputs}>
            <View style={styles.halfInput}>
              <Text style={styles.fieldLabel}>License Class</Text>
              <TouchableOpacity 
                style={styles.inputContainer}
                onPress={() => setShowLicenseClassPicker(true)}
              >
                <MaterialCommunityIcons name="truck" size={20} color={colors.foregroundMuted} />
                <Text style={[
                  styles.dateText,
                  !formData.licenseClass && styles.datePlaceholder
                ]}>
                  {formData.licenseClass || 'Select'}
                </Text>
                <Ionicons name="chevron-down" size={20} color={colors.foregroundMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.halfInput}>
              <Text style={styles.fieldLabel}>License State</Text>
              <View style={styles.inputContainer}>
                <Ionicons name="location-outline" size={20} color={colors.foregroundMuted} />
                <TextInput
                  style={styles.input}
                  placeholder="CA"
                  placeholderTextColor={colors.foregroundMuted}
                  autoCapitalize="characters"
                  maxLength={2}
                  value={formData.licenseState}
                  onChangeText={(text) => setFormData(prev => ({ ...prev, licenseState: text.toUpperCase() }))}
                />
              </View>
            </View>
          </View>

          <Text style={styles.fieldLabel}>License Expiration</Text>
          <TouchableOpacity 
            style={styles.inputContainer}
            onPress={() => setShowLicenseExpirationPicker(true)}
          >
            <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            <Text style={[
              styles.dateText,
              !licenseExpirationDate && styles.datePlaceholder
            ]}>
              {licenseExpirationDate ? formatDateDisplay(licenseExpirationDate) : 'Select expiration date'}
            </Text>
            <Ionicons name="chevron-down" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>

          {/* Contact Details Section */}
          <View style={styles.sectionHeader}>
            <Ionicons name="call" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>CONTACT DETAILS</Text>
          </View>

          <Text style={styles.fieldLabel}>Phone Number</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="call-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="+1 (555) 000-0000"
              placeholderTextColor={colors.foregroundMuted}
              keyboardType="phone-pad"
              value={formData.phone}
              onChangeText={(text) => setFormData(prev => ({ ...prev, phone: text }))}
            />
          </View>

          <Text style={styles.fieldLabel}>Email Address</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="mail-outline" size={20} color={colors.foregroundMuted} />
            <TextInput
              style={styles.input}
              placeholder="driver@logistics.com"
              placeholderTextColor={colors.foregroundMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              value={formData.email}
              onChangeText={(text) => setFormData(prev => ({ ...prev, email: text }))}
            />
          </View>

          {/* Additional Notes Section */}
          <View style={styles.sectionHeader}>
            <Ionicons name="document-text" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>ADDITIONAL NOTES</Text>
          </View>

          <View style={[styles.inputContainer, styles.textAreaContainer]}>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Add any specific instructions, medical considerations, or shift preferences..."
              placeholderTextColor={colors.foregroundMuted}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              value={formData.notes}
              onChangeText={(text) => setFormData(prev => ({ ...prev, notes: text }))}
            />
          </View>

          {/* Buttons */}
          <TouchableOpacity
            style={[styles.updateButton, isUpdating && styles.updateButtonDisabled]}
            onPress={handleUpdate}
            disabled={isUpdating}
          >
            {isUpdating ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.updateButtonText}>Save Changes</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => router.back()}
            disabled={isUpdating}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Date Picker Modal for DOB */}
        <DatePickerModal
          visible={showDatePicker}
          onClose={() => setShowDatePicker(false)}
          onSelect={(date) => {
            setDateOfBirth(date);
            setFormData(prev => ({
              ...prev,
              dateOfBirth: date.toISOString().split('T')[0],
            }));
          }}
          value={dateOfBirth}
          title="Date of Birth"
          maximumDate={new Date()}
          minimumDate={new Date(1920, 0, 1)}
        />

        {/* Date Picker Modal for License Expiration */}
        <DatePickerModal
          visible={showLicenseExpirationPicker}
          onClose={() => setShowLicenseExpirationPicker(false)}
          onSelect={(date) => {
            setLicenseExpirationDate(date);
            setFormData(prev => ({
              ...prev,
              licenseExpiration: date.toISOString().split('T')[0],
            }));
          }}
          value={licenseExpirationDate}
          title="License Expiration Date"
          minimumDate={new Date()}
          maximumDate={new Date(2050, 11, 31)}
        />

        {/* License Class Picker Modal */}
        <Modal
          visible={showLicenseClassPicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowLicenseClassPicker(false)}
        >
          <TouchableOpacity 
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowLicenseClassPicker(false)}
          >
            <View style={styles.pickerModal}>
              <Text style={styles.pickerTitle}>Select License Class</Text>
              {LICENSE_CLASSES.map((licenseClass) => (
                <TouchableOpacity
                  key={licenseClass}
                  style={[
                    styles.pickerOption,
                    formData.licenseClass === licenseClass && styles.pickerOptionSelected,
                  ]}
                  onPress={() => {
                    setFormData(prev => ({ ...prev, licenseClass }));
                    setShowLicenseClassPicker(false);
                  }}
                >
                  <Text style={[
                    styles.pickerOptionText,
                    formData.licenseClass === licenseClass && styles.pickerOptionTextSelected,
                  ]}>
                    {licenseClass}
                  </Text>
                  {formData.licenseClass === licenseClass && (
                    <Ionicons name="checkmark" size={20} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      </KeyboardAvoidingView>
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
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  resetText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  fieldLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  statusSelector: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statusOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  activeStatusOption: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '10',
  },
  statusOptionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusOptionText: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    fontWeight: '500',
  },
  activeStatusOptionText: {
    color: colors.foreground,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.primary,
    letterSpacing: 0.5,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: typography.base,
    color: colors.foreground,
  },
  rowInputs: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  textAreaContainer: {
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
  },
  textArea: {
    minHeight: 100,
    paddingTop: spacing.sm,
  },
  updateButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  updateButtonDisabled: {
    opacity: 0.7,
  },
  updateButtonText: {
    fontSize: typography.md,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  cancelButton: {
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  cancelButtonText: {
    fontSize: typography.md,
    fontWeight: '500',
    color: colors.foregroundMuted,
  },
  dateText: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: typography.base,
    color: colors.foreground,
  },
  datePlaceholder: {
    color: colors.foregroundMuted,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  pickerModal: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 320,
  },
  pickerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  pickerOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
  },
  pickerOptionSelected: {
    backgroundColor: colors.primary + '15',
  },
  pickerOptionText: {
    fontSize: typography.base,
    color: colors.foreground,
  },
  pickerOptionTextSelected: {
    fontWeight: '600',
    color: colors.primary,
  },
});
