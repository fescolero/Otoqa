import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useMutation } from 'convex/react';
import { useUser } from '@clerk/clerk-expo';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import DatePickerModal from '../../../components/DatePickerModal';

// ============================================
// COMPLETE DRIVER PROFILE
// Onboarding for owner-operators
// ============================================

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

const LICENSE_CLASSES = ['Class A', 'Class B', 'Class C'];

// Format phone number for display
function formatPhoneDisplay(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  return phone;
}

export default function CompleteDriverProfileScreen() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId } = useCarrierOwner();
  const { user } = useUser();
  const { firstName: paramFirstName, lastName: paramLastName } = useLocalSearchParams<{
    firstName?: string;
    lastName?: string;
  }>();
  
  // Get phone from Clerk user
  const userPhone = user?.primaryPhoneNumber?.phoneNumber || '';
  const phoneNumber = formatPhoneDisplay(userPhone);
  
  // Form state - pre-fill from user data if available
  const [firstName, setFirstName] = useState(paramFirstName || user?.firstName || '');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState(paramLastName || user?.lastName || '');
  const [dateOfBirth, setDateOfBirth] = useState<Date | null>(null);
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseState, setLicenseState] = useState('');
  const [licenseClass, setLicenseClass] = useState('');
  const [licenseExpiration, setLicenseExpiration] = useState<Date | null>(null);
  const [email, setEmail] = useState('');
  
  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDobPicker, setShowDobPicker] = useState(false);
  const [showExpirationPicker, setShowExpirationPicker] = useState(false);
  const [showStatePicker, setShowStatePicker] = useState(false);
  const [showClassPicker, setShowClassPicker] = useState(false);

  // Mutations
  const createOwnerDriverMutation = useMutation(api.carrierMobile.createOwnerDriver);

  const formatDate = (date: Date | null): string => {
    if (!date) return '';
    return date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
  };

  const formatDateForStorage = (date: Date | null): string => {
    if (!date) return '';
    return date.toISOString().split('T')[0];
  };

  const handleSubmit = async () => {
    // Validation
    if (!firstName.trim()) {
      Alert.alert('Required', 'Please enter your first name');
      return;
    }
    if (!lastName.trim()) {
      Alert.alert('Required', 'Please enter your last name');
      return;
    }
    if (!licenseNumber.trim()) {
      Alert.alert('Required', 'Please enter your license number');
      return;
    }
    if (!licenseState) {
      Alert.alert('Required', 'Please select your license state');
      return;
    }
    if (!licenseClass) {
      Alert.alert('Required', 'Please select your license class');
      return;
    }

    if (!carrierOrgId) {
      Alert.alert('Error', 'Organization not found');
      return;
    }

    setIsSubmitting(true);

    try {
      await createOwnerDriverMutation({
        carrierOrgId,
        firstName: firstName.trim(),
        middleName: middleName.trim() || undefined,
        lastName: lastName.trim(),
        phone: userPhone.replace(/\D/g, ''), // Use raw phone from Clerk
        email: email.trim() || undefined,
        dateOfBirth: formatDateForStorage(dateOfBirth) || undefined,
        licenseNumber: licenseNumber.trim(),
        licenseState,
        licenseClass,
        licenseExpiration: formatDateForStorage(licenseExpiration) || undefined,
      });

      Alert.alert(
        'Profile Complete',
        'Your driver profile has been created. You can now access driver features.',
        [{ text: 'Continue' }]
      );
      // The parent layout will automatically re-render since Convex queries are reactive
      // The needsDriverProfile query will return false and show the normal owner view
    } catch (error) {
      console.error('Failed to create driver profile:', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create profile. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <MaterialCommunityIcons name="dots-grid" size={24} color={colors.foregroundMuted} />
        <Text style={styles.headerTitle}>Driver Personal Info</Text>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <Text style={styles.title}>Complete Profile</Text>
        <Text style={styles.subtitle}>Please provide your details to start driving.</Text>

        {/* Identity Details Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="card-account-details" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>IDENTITY DETAILS</Text>
          </View>

          {/* First Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>First Name</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                value={firstName}
                onChangeText={setFirstName}
                placeholder="Enter first name"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="words"
              />
            </View>
          </View>

          {/* Middle Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Middle Name</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                value={middleName}
                onChangeText={setMiddleName}
                placeholder="Optional"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="words"
              />
            </View>
          </View>

          {/* Last Name */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Last Name</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                value={lastName}
                onChangeText={setLastName}
                placeholder="Enter last name"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="words"
              />
            </View>
          </View>

          {/* Date of Birth */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Date of Birth</Text>
            <TouchableOpacity
              style={styles.inputContainer}
              onPress={() => setShowDobPicker(true)}
            >
              <MaterialCommunityIcons name="calendar" size={20} color={colors.foregroundMuted} />
              <Text style={[styles.inputText, !dateOfBirth && styles.placeholder]}>
                {dateOfBirth ? formatDate(dateOfBirth) : 'mm/dd/yyyy'}
              </Text>
              <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Driver's License Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="card-account-details-outline" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>DRIVER'S LICENSE</Text>
          </View>

          {/* License Number */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>License Number</Text>
            <View style={styles.inputContainer}>
              <MaterialCommunityIcons name="card-text-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                value={licenseNumber}
                onChangeText={setLicenseNumber}
                placeholder="Enter license number"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="characters"
              />
            </View>
          </View>

          {/* State and Class Row */}
          <View style={styles.rowInputs}>
            {/* State */}
            <View style={[styles.inputGroup, { flex: 1, marginRight: spacing.md }]}>
              <Text style={styles.inputLabel}>State</Text>
              <TouchableOpacity
                style={styles.inputContainer}
                onPress={() => setShowStatePicker(true)}
              >
                <Ionicons name="location-outline" size={20} color={colors.foregroundMuted} />
                <Text style={[styles.inputText, !licenseState && styles.placeholder]}>
                  {licenseState || 'Select state'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Class */}
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={styles.inputLabel}>Class</Text>
              <TouchableOpacity
                style={styles.inputContainer}
                onPress={() => setShowClassPicker(true)}
              >
                <MaterialCommunityIcons name="card-text-outline" size={20} color={colors.foregroundMuted} />
                <Text style={[styles.inputText, !licenseClass && styles.placeholder]}>
                  {licenseClass || 'Select class'}
                </Text>
                <Ionicons name="chevron-down" size={16} color={colors.foregroundMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Expiration Date */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Expiration Date</Text>
            <TouchableOpacity
              style={styles.inputContainer}
              onPress={() => setShowExpirationPicker(true)}
            >
              <MaterialCommunityIcons name="calendar" size={20} color={colors.foregroundMuted} />
              <Text style={[styles.inputText, !licenseExpiration && styles.placeholder]}>
                {licenseExpiration ? formatDate(licenseExpiration) : 'mm/dd/yyyy'}
              </Text>
              <Ionicons name="calendar-outline" size={20} color={colors.foregroundMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Contact Information Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="call-outline" size={18} color={colors.primary} />
            <Text style={styles.sectionTitle}>CONTACT INFORMATION</Text>
          </View>

          {/* Phone Number (Auto-filled, non-editable) */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Phone Number (Auto-filled)</Text>
            <View style={[styles.inputContainer, styles.inputDisabled]}>
              <Ionicons name="call-outline" size={20} color={colors.foregroundMuted} />
              <Text style={styles.inputText}>{phoneNumber}</Text>
            </View>
          </View>

          {/* Email */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Email Address</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="mail-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="email@example.com"
                placeholderTextColor={colors.foregroundMuted}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Bottom Button */}
      <View style={[styles.bottomContainer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <TouchableOpacity
          style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <Text style={styles.submitButtonText}>Complete Registration</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.termsText}>
          By continuing, you agree to our Terms of Service and Privacy Policy for professional drivers.
        </Text>
      </View>

      {/* Date of Birth Picker */}
      <DatePickerModal
        visible={showDobPicker}
        onClose={() => setShowDobPicker(false)}
        onSelect={(date) => {
          setDateOfBirth(date);
          setShowDobPicker(false);
        }}
        value={dateOfBirth || new Date(2000, 0, 1)}
        title="Date of Birth"
        minimumDate={new Date(1940, 0, 1)}
        maximumDate={new Date(2010, 11, 31)}
      />

      {/* License Expiration Picker */}
      <DatePickerModal
        visible={showExpirationPicker}
        onClose={() => setShowExpirationPicker(false)}
        onSelect={(date) => {
          setLicenseExpiration(date);
          setShowExpirationPicker(false);
        }}
        value={licenseExpiration || new Date(2030, 0, 1)}
        title="License Expiration Date"
        minimumDate={new Date()}
        maximumDate={new Date(2040, 11, 31)}
      />

      {/* State Picker Modal */}
      <Modal
        visible={showStatePicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowStatePicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => setShowStatePicker(false)}
          />
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select State</Text>
              <TouchableOpacity onPress={() => setShowStatePicker(false)}>
                <Ionicons name="close" size={24} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.pickerList}>
              {US_STATES.map((state) => (
                <TouchableOpacity
                  key={state}
                  style={[
                    styles.pickerOption,
                    licenseState === state && styles.pickerOptionSelected,
                  ]}
                  onPress={() => {
                    setLicenseState(state);
                    setShowStatePicker(false);
                  }}
                >
                  <Text
                    style={[
                      styles.pickerOptionText,
                      licenseState === state && styles.pickerOptionTextSelected,
                    ]}
                  >
                    {state}
                  </Text>
                  {licenseState === state && (
                    <Ionicons name="checkmark" size={20} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Class Picker Modal */}
      <Modal
        visible={showClassPicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowClassPicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => setShowClassPicker(false)}
          />
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select License Class</Text>
              <TouchableOpacity onPress={() => setShowClassPicker(false)}>
                <Ionicons name="close" size={24} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <View style={styles.pickerList}>
              {LICENSE_CLASSES.map((cls) => (
                <TouchableOpacity
                  key={cls}
                  style={[
                    styles.pickerOption,
                    licenseClass === cls && styles.pickerOptionSelected,
                  ]}
                  onPress={() => {
                    setLicenseClass(cls);
                    setShowClassPicker(false);
                  }}
                >
                  <Text
                    style={[
                      styles.pickerOptionText,
                      licenseClass === cls && styles.pickerOptionTextSelected,
                    ]}
                  >
                    {cls}
                  </Text>
                  {licenseClass === cls && (
                    <Ionicons name="checkmark" size={20} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </Modal>
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
    gap: spacing.sm,
  },
  headerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    marginBottom: spacing.xl,
  },

  // Section
  section: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadows.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.5,
  },

  // Input
  inputGroup: {
    marginBottom: spacing.md,
  },
  inputLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginBottom: spacing.xs,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.muted,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  inputDisabled: {
    opacity: 0.7,
  },
  input: {
    flex: 1,
    fontSize: typography.base,
    color: colors.foreground,
  },
  inputText: {
    flex: 1,
    fontSize: typography.base,
    color: colors.foreground,
  },
  placeholder: {
    color: colors.foregroundMuted,
  },
  rowInputs: {
    flexDirection: 'row',
  },

  // Bottom
  bottomContainer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.background,
  },
  termsText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 18,
  },

  // Picker Modal
  pickerOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  pickerSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    maxHeight: '60%',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  pickerList: {
    padding: spacing.md,
  },
  pickerOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
  },
  pickerOptionSelected: {
    backgroundColor: colors.primary + '20',
  },
  pickerOptionText: {
    fontSize: typography.base,
    color: colors.foreground,
  },
  pickerOptionTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },
});
