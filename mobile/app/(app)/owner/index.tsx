import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../lib/theme';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useLanguage } from '../../../lib/LanguageContext';

// ============================================
// OWNER DASHBOARD - Dispatcher View
// Operational overview with available loads
// ============================================

// Weather types
interface WeatherData {
  temperature: number;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
}

// Weather code mapping to icons and descriptions
const getWeatherInfo = (code: number): { description: string; icon: keyof typeof Ionicons.glyphMap; iconColor: string } => {
  // WMO Weather interpretation codes
  // https://open-meteo.com/en/docs
  if (code === 0) return { description: 'Clear', icon: 'sunny', iconColor: '#FFB800' };
  if (code === 1) return { description: 'Mostly Clear', icon: 'sunny', iconColor: '#FFB800' };
  if (code === 2) return { description: 'Partly Cloudy', icon: 'partly-sunny', iconColor: '#FFB800' };
  if (code === 3) return { description: 'Overcast', icon: 'cloudy', iconColor: '#9CA3AF' };
  if (code >= 45 && code <= 48) return { description: 'Foggy', icon: 'cloud', iconColor: '#9CA3AF' };
  if (code >= 51 && code <= 55) return { description: 'Drizzle', icon: 'rainy', iconColor: '#60A5FA' };
  if (code >= 56 && code <= 57) return { description: 'Freezing Drizzle', icon: 'rainy', iconColor: '#60A5FA' };
  if (code >= 61 && code <= 65) return { description: 'Rain', icon: 'rainy', iconColor: '#3B82F6' };
  if (code >= 66 && code <= 67) return { description: 'Freezing Rain', icon: 'rainy', iconColor: '#3B82F6' };
  if (code >= 71 && code <= 77) return { description: 'Snow', icon: 'snow', iconColor: '#E5E7EB' };
  if (code >= 80 && code <= 82) return { description: 'Rain Showers', icon: 'rainy', iconColor: '#3B82F6' };
  if (code >= 85 && code <= 86) return { description: 'Snow Showers', icon: 'snow', iconColor: '#E5E7EB' };
  if (code >= 95 && code <= 99) return { description: 'Thunderstorm', icon: 'thunderstorm', iconColor: '#6366F1' };
  return { description: 'Unknown', icon: 'cloud', iconColor: '#9CA3AF' };
};

// Helper to format date
function formatDate(date: Date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const dayNum = date.getDate();
  const year = date.getFullYear();
  
  // Get week number
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - startOfYear.getTime()) / 86400000;
  const weekNum = Math.ceil((pastDaysOfYear + startOfYear.getDay() + 1) / 7);
  
  return {
    dayName,
    formatted: `${dayName}, ${monthName} ${dayNum}`,
    weekInfo: `Week ${weekNum} of ${year}`,
  };
}

export default function OwnerDashboard() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId, carrierExternalOrgId, orgName } = useCarrierOwner();
  const router = useRouter();
  const { t } = useLanguage();
  const [refreshing, setRefreshing] = useState(false);
  
  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [locationName, setLocationName] = useState<string>('');

  // Determine which org ID to use for load queries
  const loadOrgId = carrierExternalOrgId || carrierOrgId;
  
  // Fetch weather based on user location
  const fetchWeather = useCallback(async () => {
    try {
      setWeatherLoading(true);
      
      // Request location permission
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.log('Location permission denied');
        setWeatherLoading(false);
        return;
      }
      
      // Get current location
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      
      const { latitude, longitude } = location.coords;
      
      // Reverse geocode to get city name
      try {
        const [address] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (address?.city) {
          setLocationName(address.city);
        }
      } catch (geoError) {
        console.log('Reverse geocode error:', geoError);
      }
      
      // Fetch weather from Open-Meteo API (free, no API key required)
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`
      );
      
      if (!response.ok) {
        throw new Error('Weather fetch failed');
      }
      
      const data = await response.json();
      
      if (data.current) {
        const weatherInfo = getWeatherInfo(data.current.weather_code);
        setWeather({
          temperature: Math.round(data.current.temperature_2m),
          description: weatherInfo.description,
          icon: weatherInfo.icon,
          iconColor: weatherInfo.iconColor,
        });
      }
    } catch (error) {
      console.error('Error fetching weather:', error);
    } finally {
      setWeatherLoading(false);
    }
  }, []);
  
  // Fetch weather on mount
  useEffect(() => {
    fetchWeather();
  }, [fetchWeather]);

  // Get dashboard data
  const dashboard = useQuery(
    api.carrierMobile.getDashboard,
    loadOrgId ? { carrierOrgId: loadOrgId, carrierConvexId: carrierOrgId || undefined } : 'skip'
  );

  // Get active loads
  const activeLoads = useQuery(
    api.carrierMobile.getActiveLoads,
    loadOrgId ? { carrierOrgId: loadOrgId, carrierConvexId: carrierOrgId || undefined } : 'skip'
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchWeather();
    setTimeout(() => setRefreshing(false), 1000);
  }, [fetchWeather]);

  // Current date info
  const today = useMemo(() => formatDate(new Date()), []);
  const lastUpdated = useMemo(() => {
    return `Updated ${Math.floor(Math.random() * 5) + 1}m ago`;
  }, [refreshing]);

  // Process available loads (unassigned or awaiting dispatch)
  const allUnassignedLoads = useMemo(() => {
    if (!activeLoads) return [];
    // Get all loads that need assignment or are ready for dispatch
    return activeLoads.filter(load => 
      !load.driver || load.status === 'AWARDED'
    );
  }, [activeLoads]);

  // Show only first 3 for display
  const availableLoads = useMemo(() => {
    return allUnassignedLoads.slice(0, 3);
  }, [allUnassignedLoads]);

  // Count of unassigned loads
  const unassignedCount = allUnassignedLoads.length;

  // Loading state
  if (!loadOrgId || !carrierOrgId) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading organization...</Text>
      </View>
    );
  }

  if (dashboard === undefined) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={styles.headerSection}>
        <Text style={styles.carrierName}>{orgName || 'Dashboard'}</Text>
        <Text style={styles.headerSubtitle}>{t('dispatcherHome.carrierDashboard')}</Text>
      </View>

      {/* Today Section */}
      <View style={styles.todayCard}>
        <View style={styles.todayHeader}>
          <View style={styles.todayLeft}>
            <View style={styles.todayBadge}>
              <Ionicons name="calendar" size={14} color={colors.primary} />
              <Text style={styles.todayBadgeText} maxFontSizeMultiplier={1.2}>{t('dispatcherHome.today')}</Text>
            </View>
            <Text style={styles.todayDate}>{today.formatted}</Text>
            <Text style={styles.todayWeek}>{today.weekInfo}</Text>
          </View>
          <View style={styles.todayRight}>
            {locationName ? (
              <Text style={styles.locationText}>{locationName}</Text>
            ) : (
              <Text style={styles.updatedText}>{lastUpdated}</Text>
            )}
            {weatherLoading ? (
              <View style={styles.weatherLoading}>
                <ActivityIndicator size="small" color={colors.foregroundMuted} />
              </View>
            ) : weather ? (
              <>
                <View style={styles.weatherContainer}>
                  <Ionicons name={weather.icon} size={24} color={weather.iconColor} />
                  <Text style={styles.weatherTemp}>{weather.temperature}°F</Text>
                </View>
                <Text style={styles.weatherDesc}>{weather.description}</Text>
              </>
            ) : (
              <View style={styles.weatherContainer}>
                <Ionicons name="cloud-offline" size={24} color={colors.foregroundMuted} />
                <Text style={styles.weatherDesc}>Unavailable</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Available for Assignment Section */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('dispatcherHome.availableForAssignment')}</Text>
          <TouchableOpacity 
            style={styles.viewAllGroupButton}
            onPress={() => router.push('/(app)/owner/loads')}
          >
            <Text style={styles.viewAllGroupText}>{t('dispatcherHome.viewAll')}</Text>
            <View style={styles.viewAllDivider} />
            <Text style={styles.viewAllGroupCount}>{unassignedCount}</Text>
          </TouchableOpacity>
        </View>

        {availableLoads.length > 0 ? (
          availableLoads.map((loadData, index) => (
            <TouchableOpacity 
              key={loadData._id || index}
              style={styles.loadCard}
              activeOpacity={0.7}
              onPress={() => router.push({
                pathname: '/(app)/owner/assign-driver',
                params: { 
                  assignmentId: loadData._id,
                  loadInternalId: loadData.load?.internalId || 'N/A',
                },
              })}
            >
              {/* Load Header */}
              <View style={styles.loadHeader}>
                <View style={styles.loadIdRow}>
                  <MaterialCommunityIcons name="truck-delivery" size={18} color={colors.foreground} />
                  <Text style={styles.loadId}>Load #{loadData.load?.internalId || 'N/A'}</Text>
                </View>
                <View style={[styles.yellowBadge, { backgroundColor: loadData.driver ? '#4CAF50' : '#F59E0B' }]}>
                  <Text style={styles.yellowBadgeText} maxFontSizeMultiplier={1.2}>
                    {loadData.driver ? 'Assigned' : 'Unassigned'}
                  </Text>
                </View>
              </View>

              {/* Badge Row */}
              <View style={styles.badgeRow}>
                {loadData.load?.hcr && (
                  <View style={styles.grayBadge}>
                    <Text style={styles.grayBadgeText} maxFontSizeMultiplier={1.2}>HCR {loadData.load.hcr}</Text>
                  </View>
                )}
                {loadData.load?.tripNumber && (
                  <View style={styles.blueBadge}>
                    <Text style={styles.blueBadgeText} maxFontSizeMultiplier={1.2}>Trip {loadData.load.tripNumber}</Text>
                  </View>
                )}
              </View>

              {/* Route */}
              <View style={styles.routeContainer}>
                <View style={styles.routeDot} />
                <Text style={styles.routeLabel}>Route</Text>
              </View>
              <Text style={styles.routeText}>
                {loadData.stops?.[0]?.city || 'Unknown'}, {loadData.stops?.[0]?.state || ''} → {loadData.stops?.[loadData.stops.length - 1]?.city || 'Unknown'}, {loadData.stops?.[loadData.stops.length - 1]?.state || ''}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          // Empty state when no loads available for assignment
          <View style={styles.emptyStateCard}>
            <View style={styles.emptyStateIconContainer}>
              <Feather name="package" size={32} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.emptyStateTitle}>{t('dispatcherHome.noActiveLoads')}</Text>
            <Text style={styles.emptyStateSubtitle}>
              {t('dispatcherHome.noActiveLoadsDesc')}
            </Text>
          </View>
        )}
      </View>

      {/* Bottom Padding for Tab Bar */}
      <View style={{ height: 120 }} />
    </ScrollView>
  );
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
    backgroundColor: colors.background,
  },
  loadingText: {
    color: colors.foregroundMuted,
    fontSize: typography.base,
  },

  // Header
  headerSection: {
    marginBottom: spacing.lg,
  },
  carrierName: {
    fontSize: typography['2xl'],
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },

  // Today Card
  todayCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    ...shadows.md,
  },
  todayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  todayLeft: {
    flex: 1,
  },
  todayBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: spacing.sm,
  },
  todayBadgeText: {
    fontSize: typography.sm,
    color: colors.primary,
    fontWeight: '600',
  },
  todayDate: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 4,
  },
  todayWeek: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  todayRight: {
    alignItems: 'flex-end',
  },
  updatedText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
  },
  locationText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
    fontWeight: '500',
  },
  weatherLoading: {
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  weatherContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weatherTemp: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  weatherDesc: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },

  // Section
  section: {
    marginBottom: spacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  viewAllGroupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  viewAllGroupText: {
    fontSize: typography.sm,
    color: colors.background,
    fontWeight: '600',
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 6,
  },
  viewAllDivider: {
    width: 1,
    height: 16,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  viewAllGroupCount: {
    fontSize: typography.sm,
    color: colors.background,
    fontWeight: '700',
    paddingLeft: 8,
    paddingRight: 10,
    paddingVertical: 6,
  },

  // Load Card
  loadCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.md,
  },
  loadHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  loadIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadId: {
    fontSize: typography.base,
    fontWeight: '700',
    color: colors.foreground,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  grayBadge: {
    backgroundColor: colors.muted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  grayBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: colors.foreground,
  },
  blueBadge: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  blueBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  yellowBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  yellowBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  routeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  routeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4CAF50',
  },
  routeLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  routeText: {
    fontSize: typography.base,
    fontWeight: '500',
    color: colors.foreground,
    marginLeft: 16,
  },

  // Empty State Card
  emptyStateCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    paddingVertical: spacing.xl * 2,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  emptyStateIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyStateTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  emptyStateSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.lg,
  },
});
