import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  TextInput,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation } from 'convex/react';
import { router } from 'expo-router';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../../lib/theme';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState, useCallback, useMemo } from 'react';
import { Id } from '../../../../../convex/_generated/dataModel';
import DatePickerModal from '../../../../components/DatePickerModal';

// ============================================
// DRIVER MANAGEMENT SCREEN
// List, search, filter and manage carrier's drivers
// ============================================

type FilterType = 'all' | 'onRoute' | 'resting' | 'offline';
type EmploymentStatus = 'Active' | 'Suspended' | 'Terminated';

interface NewDriverForm {
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

const initialFormState: NewDriverForm = {
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
};

export default function DriversScreen() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId } = useCarrierOwner();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newDriver, setNewDriver] = useState<NewDriverForm>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [showDobPicker, setShowDobPicker] = useState(false);
  const [showLicenseExpirationPicker, setShowLicenseExpirationPicker] = useState(false);
  const [showLicenseClassPicker, setShowLicenseClassPicker] = useState(false);
  const [dateOfBirth, setDateOfBirth] = useState<Date | null>(null);
  const [licenseExpirationDate, setLicenseExpirationDate] = useState<Date | null>(null);

  const LICENSE_CLASSES = ['Class A', 'Class B', 'Class C'] as const;

  const drivers = useQuery(
    api.carrierMobile.getDrivers,
    carrierOrgId ? { carrierOrgId } : 'skip'
  );

  // Mutation for creating a driver
  const createDriverMutation = useMutation(api.carrierMobile.createDriver);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  // Get driver status based on their state
  const getDriverStatus = useCallback((driver: any) => {
    if (driver.currentAssignment) {
      // Simulate different statuses
      const statuses = ['On Schedule', 'Delayed', 'At Destination'];
      const hash = driver._id.charCodeAt(0) % 3;
      const status = statuses[hash];
      
      if (status === 'Delayed') {
        return { label: 'Delayed', color: '#FF6B6B', type: 'onRoute' };
      }
      if (status === 'At Destination') {
        return { label: 'At Destination', color: colors.primary, type: 'onRoute' };
      }
      return { label: 'On Schedule', color: '#4CAF50', type: 'onRoute' };
    }
    if (driver.lastLocation) {
      // Recent location but no load = resting
      return { label: 'Off Duty', color: colors.foregroundMuted, type: 'resting' };
    }
    return { label: 'Offline', color: colors.foregroundMuted, type: 'offline' };
  }, []);

  // Filter and search drivers
  const filteredDrivers = useMemo(() => {
    if (!drivers) return [];
    
    let result = drivers;
    
    // Apply filter
    if (filter !== 'all') {
      result = result.filter(driver => {
        const status = getDriverStatus(driver);
        return status.type === filter;
      });
    }
    
    // Apply search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(driver => 
        driver.firstName.toLowerCase().includes(query) ||
        driver.lastName.toLowerCase().includes(query) ||
        driver.phone.includes(query)
      );
    }
    
    return result;
  }, [drivers, filter, searchQuery, getDriverStatus]);

  // Count drivers by status
  const statusCounts = useMemo(() => {
    if (!drivers) return { all: 0, onRoute: 0, resting: 0, offline: 0 };
    
    return {
      all: drivers.length,
      onRoute: drivers.filter(d => getDriverStatus(d).type === 'onRoute').length,
      resting: drivers.filter(d => getDriverStatus(d).type === 'resting').length,
      offline: drivers.filter(d => getDriverStatus(d).type === 'offline').length,
    };
  }, [drivers, getDriverStatus]);

  // Get active load ID if driver has assignment
  const getDriverExtras = useCallback((driver: any) => {
    const loadId = driver.currentLoad?.internalId ? `#${driver.currentLoad.internalId}` : null;
    return { loadId };
  }, []);

  const handleCall = (phone: string) => {
    Linking.openURL(`tel:${phone}`);
  };

  const handleMessage = (phone: string) => {
    Linking.openURL(`sms:${phone}`);
  };

  const resetForm = () => {
    setNewDriver(initialFormState);
    setDateOfBirth(null);
    setLicenseExpirationDate(null);
  };

  // Format date for display
  const formatDateDisplay = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleCreateDriver = async () => {
    // Validate required fields
    if (!newDriver.firstName.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s first name.');
      return;
    }
    if (!newDriver.lastName.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s last name.');
      return;
    }
    if (!newDriver.phone.trim()) {
      Alert.alert('Missing Information', 'Please enter the driver\'s phone number.');
      return;
    }
    if (!carrierOrgId) {
      Alert.alert('Error', 'Organization not found. Please try again.');
      return;
    }

    setIsCreating(true);

    try {
      const result = await createDriverMutation({
        carrierOrgId: carrierOrgId,
        firstName: newDriver.firstName.trim(),
        middleName: newDriver.middleName.trim() || undefined,
        lastName: newDriver.lastName.trim(),
        email: newDriver.email.trim() || `${newDriver.firstName.toLowerCase()}.${newDriver.lastName.toLowerCase()}@driver.local`,
        phone: newDriver.phone.trim(),
        dateOfBirth: newDriver.dateOfBirth.trim() || undefined,
        licenseNumber: newDriver.licenseNumber.trim() || undefined,
        licenseState: newDriver.licenseState.trim() || undefined,
        licenseClass: newDriver.licenseClass.trim() || undefined,
        licenseExpiration: newDriver.licenseExpiration.trim() || undefined,
        employmentStatus: newDriver.employmentStatus,
        employmentType: 'Full-time',
        notes: newDriver.notes.trim() || undefined,
      });

      if (result.success) {
        Alert.alert(
          'Driver Created',
          `${newDriver.firstName} ${newDriver.lastName} has been added successfully.`,
          [{ text: 'OK' }]
        );
        setShowAddModal(false);
        resetForm();
      }
    } catch (error: any) {
      console.error('Error creating driver:', error);
      Alert.alert(
        'Error',
        error.message || 'Failed to create driver. Please try again.'
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleDriverPress = (driverId: string) => {
    router.push({
      pathname: '/(app)/driver/[id]',
      params: { id: driverId },
    });
  };

  const renderDriver = ({ item: driver }: { item: any }) => {
    const extras = getDriverExtras(driver);

    return (
      <TouchableOpacity 
        style={styles.driverCard}
        onPress={() => handleDriverPress(driver._id)}
        activeOpacity={0.7}
      >
        <View style={styles.cardContent}>
          {/* Left - Name and Load */}
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>
              {driver.firstName} {driver.lastName}
            </Text>
            {extras.loadId ? (
              <Text style={styles.activeLoad}>Active Load: {extras.loadId}</Text>
            ) : (
              <Text style={styles.noLoad}>No Active Load</Text>
            )}
          </View>
          
          {/* Right - Action Buttons */}
          <View style={styles.actionButtons}>
            <TouchableOpacity 
              style={[styles.actionButton, styles.callButton]}
              onPress={(e) => {
                e.stopPropagation();
                handleCall(driver.phone);
              }}
            >
              <Ionicons name="call" size={18} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.actionButton, styles.messageButton]}
              onPress={(e) => {
                e.stopPropagation();
                handleMessage(driver.phone);
              }}
            >
              <Ionicons name="chatbubble" size={18} color="#4CAF50" />
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const FilterTab = ({ type, label }: { type: FilterType; label: string }) => (
    <TouchableOpacity
      style={[styles.filterTab, filter === type && styles.activeFilterTab]}
      onPress={() => setFilter(type)}
    >
      <Text style={[styles.filterText, filter === type && styles.activeFilterText]}>
        {label} ({statusCounts[type]})
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Manage Drivers</Text>
        </View>
        <TouchableOpacity 
          style={styles.addButton}
          onPress={() => setShowAddModal(true)}
        >
          <Ionicons name="add" size={20} color={colors.primaryForeground} />
          <Text style={styles.addButtonText}>Add Driver</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color={colors.foregroundMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, truck ID, or load..."
          placeholderTextColor={colors.foregroundMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={20} color={colors.foregroundMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter Tabs */}
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filterBarContent}
      >
        <FilterTab type="all" label="All Drivers" />
        <FilterTab type="onRoute" label="On Route" />
        <FilterTab type="resting" label="Resting" />
        <FilterTab type="offline" label="Offline" />
      </ScrollView>

      {/* Driver List */}
      <FlatList
        data={filteredDrivers}
        renderItem={renderDriver}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={48} color={colors.foregroundMuted} />
            <Text style={styles.emptyText}>No drivers found</Text>
            <Text style={styles.emptySubtext}>
              {searchQuery ? 'Try a different search term' : 'Add drivers to manage them here'}
            </Text>
          </View>
        }
      />

      {/* Add Driver Modal */}
      <Modal
        visible={showAddModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowAddModal(false)}
      >
        <KeyboardAvoidingView 
          style={styles.modalContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.modalHeader, { paddingTop: insets.top + spacing.md }]}>
            <TouchableOpacity onPress={() => setShowAddModal(false)}>
              <Ionicons name="arrow-back" size={24} color={colors.foreground} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Add New Driver</Text>
            <TouchableOpacity onPress={resetForm}>
              <Text style={styles.resetText}>Reset</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
            {/* Employment Status */}
            <Text style={styles.fieldLabel}>Employment Status</Text>
            <View style={styles.statusSelector}>
              {(['Active', 'Suspended', 'Terminated'] as EmploymentStatus[]).map((status) => (
                <TouchableOpacity
                  key={status}
                  style={[
                    styles.statusOption,
                    newDriver.employmentStatus === status && styles.activeStatusOption,
                  ]}
                  onPress={() => setNewDriver(prev => ({ ...prev, employmentStatus: status }))}
                >
                  <View style={[
                    styles.statusOptionDot,
                    { backgroundColor: status === 'Active' ? '#4CAF50' : status === 'Suspended' ? colors.warning : '#FF6B6B' }
                  ]} />
                  <Text style={[
                    styles.statusOptionText,
                    newDriver.employmentStatus === status && styles.activeStatusOptionText
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
                value={newDriver.firstName}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, firstName: text }))}
              />
            </View>

            <Text style={styles.fieldLabel}>Middle Name (Optional)</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                placeholder="Michael"
                placeholderTextColor={colors.foregroundMuted}
                value={newDriver.middleName}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, middleName: text }))}
              />
            </View>

            <Text style={styles.fieldLabel}>Last Name</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color={colors.foregroundMuted} />
              <TextInput
                style={styles.input}
                placeholder="Doe"
                placeholderTextColor={colors.foregroundMuted}
                value={newDriver.lastName}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, lastName: text }))}
              />
            </View>

            <Text style={styles.fieldLabel}>Date of Birth</Text>
            <TouchableOpacity 
              style={styles.inputContainer}
              onPress={() => setShowDobPicker(true)}
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
                value={newDriver.licenseNumber}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, licenseNumber: text }))}
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
                    !newDriver.licenseClass && styles.datePlaceholder
                  ]}>
                    {newDriver.licenseClass || 'Select'}
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
                    value={newDriver.licenseState}
                    onChangeText={(text) => setNewDriver(prev => ({ ...prev, licenseState: text.toUpperCase() }))}
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
                value={newDriver.phone}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, phone: text }))}
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
                value={newDriver.email}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, email: text }))}
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
                value={newDriver.notes}
                onChangeText={(text) => setNewDriver(prev => ({ ...prev, notes: text }))}
              />
            </View>

            {/* Buttons */}
            <TouchableOpacity 
              style={[styles.createButton, isCreating && styles.createButtonDisabled]} 
              onPress={handleCreateDriver}
              disabled={isCreating}
            >
              {isCreating ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.createButtonText}>Create Driver Profile</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.cancelButton} 
              onPress={() => setShowAddModal(false)}
              disabled={isCreating}
            >
              <Text style={styles.cancelButtonText}>Cancel & Exit</Text>
            </TouchableOpacity>

            <View style={{ height: 40 }} />
          </ScrollView>

          {/* Date of Birth Picker */}
          <DatePickerModal
            visible={showDobPicker}
            onClose={() => setShowDobPicker(false)}
            onSelect={(date) => {
              setDateOfBirth(date);
              setNewDriver(prev => ({
                ...prev,
                dateOfBirth: date.toISOString().split('T')[0],
              }));
            }}
            value={dateOfBirth}
            title="Date of Birth"
            maximumDate={new Date()}
            minimumDate={new Date(1920, 0, 1)}
          />

          {/* License Expiration Picker */}
          <DatePickerModal
            visible={showLicenseExpirationPicker}
            onClose={() => setShowLicenseExpirationPicker(false)}
            onSelect={(date) => {
              setLicenseExpirationDate(date);
              setNewDriver(prev => ({
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
              style={styles.licenseClassOverlay}
              activeOpacity={1}
              onPress={() => setShowLicenseClassPicker(false)}
            >
              <View style={styles.licenseClassModal}>
                <Text style={styles.licenseClassTitle}>Select License Class</Text>
                {LICENSE_CLASSES.map((licenseClass) => (
                  <TouchableOpacity
                    key={licenseClass}
                    style={[
                      styles.licenseClassOption,
                      newDriver.licenseClass === licenseClass && styles.licenseClassOptionSelected,
                    ]}
                    onPress={() => {
                      setNewDriver(prev => ({ ...prev, licenseClass }));
                      setShowLicenseClassPicker(false);
                    }}
                  >
                    <Text style={[
                      styles.licenseClassOptionText,
                      newDriver.licenseClass === licenseClass && styles.licenseClassOptionTextSelected,
                    ]}>
                      {licenseClass}
                    </Text>
                    {newDriver.licenseClass === licenseClass && (
                      <Ionicons name="checkmark" size={20} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </Modal>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  
  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    gap: 4,
  },
  addButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.sm,
    fontWeight: '600',
  },

  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: typography.base,
    color: colors.foreground,
  },

  // Filter Tabs
  filterBar: {
    maxHeight: 36,
    marginBottom: spacing.md,
  },
  filterBarContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  filterTab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeFilterTab: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterText: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    fontWeight: '500',
    textAlign: 'center',
  },
  activeFilterText: {
    color: colors.primaryForeground,
    fontWeight: '600',
  },

  // Driver Card
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 120,
  },
  driverCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.md,
  },
  cardContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  driverInfo: {
    flex: 1,
  },
  driverName: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 4,
  },
  activeLoad: {
    fontSize: typography.sm,
    color: colors.primary,
    fontWeight: '500',
  },
  noLoad: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callButton: {
    backgroundColor: colors.primary + '20',
  },
  messageButton: {
    backgroundColor: '#4CAF5020',
  },

  // Empty State
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    fontSize: typography.lg,
    color: colors.foreground,
    marginTop: spacing.md,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },

  // Modal
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  resetText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },

  // Form
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
  createButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  createButtonDisabled: {
    opacity: 0.7,
  },
  createButtonText: {
    color: colors.primaryForeground,
    fontSize: typography.base,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: colors.card,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: {
    color: colors.foreground,
    fontSize: typography.base,
    fontWeight: '500',
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
  licenseClassOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  licenseClassModal: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 320,
  },
  licenseClassTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  licenseClassOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
  },
  licenseClassOptionSelected: {
    backgroundColor: colors.primary + '15',
  },
  licenseClassOptionText: {
    fontSize: typography.base,
    color: colors.foreground,
  },
  licenseClassOptionTextSelected: {
    fontWeight: '600',
    color: colors.primary,
  },
});
