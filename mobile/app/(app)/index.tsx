import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useMyLoads } from '../../lib/hooks/useMyLoads';
import { useNetworkStatus } from '../../lib/hooks/useNetworkStatus';
import { useOfflineQueue } from '../../lib/hooks/useOfflineQueue';
import { useDriver } from './_layout';
import { colors, typography, spacing, borderRadius, shadows, isIOS } from '../../lib/theme';
import { useLanguage } from '../../lib/LanguageContext';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

// ============================================
// HOME SCREEN - Dark Logistics Design
// Professional Driver Dashboard
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

export default function HomeScreen() {
  const router = useRouter();
  const { driverId } = useDriver();
  const { loads, isLoading, refetch, isRefetching } = useMyLoads(driverId);
  const { isConnected } = useNetworkStatus();
  const { pendingCount } = useOfflineQueue();
  const { t, locale } = useLanguage();
  const [showCompleted, setShowCompleted] = useState(false);

  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);

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

  // Enhanced refetch that includes weather
  const handleRefresh = useCallback(async () => {
    await Promise.all([refetch(), fetchWeather()]);
  }, [refetch, fetchWeather]);

  // Separate active, upcoming, and completed loads
  const { activeLoad, scheduledLoads, completedLoads } = useMemo(() => {
    if (!loads || loads.length === 0) {
      return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
    }

    const completed = loads.filter((l) => l.status === 'Completed' || l.trackingStatus === 'Completed');
    const active = loads.filter((l) => l.status !== 'Completed' && l.trackingStatus !== 'Completed');
    
    // Only show as "Current Load" if actually in transit/in progress
    const inProgress = active.find(
      (l) => l.trackingStatus === 'In Transit' || 
             l.trackingStatus === 'At Pickup' || 
             l.trackingStatus === 'At Delivery' ||
             l.status === 'In Progress'
    );
    
    // All non-completed loads that aren't the current one go to scheduled
    const scheduled = active
      .filter((l) => l._id !== inProgress?._id)
      .sort((a, b) => {
        const timeA = a.firstPickup?.windowBeginDate || '';
        const timeB = b.firstPickup?.windowBeginDate || '';
        return timeA.localeCompare(timeB);
      });

    return { 
      activeLoad: inProgress, 
      scheduledLoads: scheduled,
      completedLoads: completed 
    };
  }, [loads]);

  // Format date for header
  const formatHeaderDate = () => {
    const now = new Date();
    return now.toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US', { 
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  // Check if load is multi-day
  const isMultiDay = (load: typeof activeLoad) => {
    if (!load?.firstPickup?.windowBeginDate || !load?.lastDelivery?.windowBeginDate) return false;
    const pickupDate = load.firstPickup.windowBeginDate.split('T')[0];
    const deliveryDate = load.lastDelivery.windowBeginDate.split('T')[0];
    return pickupDate !== deliveryDate;
  };

  // Get multi-day continuation date
  const getMultiDayDate = (load: typeof activeLoad) => {
    if (!load?.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return null;
    }
  };

  // Format time only
  const formatTime = (timeStr?: string) => {
    if (!timeStr) return null;
    try {
      const date = new Date(timeStr);
      if (isNaN(date.getTime())) return null;
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return null;
    }
  };

  // Format date and time together
  const formatDateTime = (dateStr?: string, timeStr?: string) => {
    if (!dateStr && !timeStr) return null;
    try {
      // Try to get date from dateStr
      const dateObj = dateStr ? new Date(dateStr) : null;
      const timeObj = timeStr ? new Date(timeStr) : null;
      
      // Format date part (e.g., "Jan 15")
      const datePart = dateObj && !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : null;
      
      // Format time part
      const timePart = timeObj && !isNaN(timeObj.getTime())
        ? timeObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        : (dateObj && !isNaN(dateObj.getTime()) 
            ? dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            : null);
      
      if (datePart && timePart) {
        return `${datePart}, ${timePart}`;
      }
      return datePart || timePart || null;
    } catch {
      return null;
    }
  };

  // Format expected delivery
  const formatExpectedDelivery = (load: typeof activeLoad) => {
    if (!load?.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      const time = load.lastDelivery?.windowEndTime 
        ? formatTime(load.lastDelivery.windowEndTime) 
        : formatTime(load.lastDelivery.windowBeginDate);
      const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      return `${dateStr}, ${time || ''}`;
    } catch {
      return null;
    }
  };

  // Get pickup address
  const getPickupAddress = (load: typeof activeLoad) => {
    if (!load?.firstPickup) return 'Address pending';
    const { address, city, state, postalCode } = load.firstPickup;
    if (address && city && state) {
      return `${address}, ${city}, ${state} ${postalCode || ''}`.trim();
    }
    if (city && state) return `${city}, ${state}`;
    return 'Address pending';
  };

  // Get delivery address
  const getDeliveryAddress = (load: typeof activeLoad) => {
    if (!load?.lastDelivery) return 'Address pending';
    const { address, city, state, postalCode } = load.lastDelivery;
    if (address && city && state) {
      return `${address}, ${city}, ${state} ${postalCode || ''}`.trim();
    }
    if (city && state) return `${city}, ${state}`;
    return 'Address pending';
  };

  // Loading skeleton
  const LoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      <View style={[styles.skeletonBox, { height: 80, marginBottom: 16 }]} />
      <View style={[styles.skeletonBox, { height: 200, marginBottom: 12 }]} />
      <View style={[styles.skeletonBox, { height: 200 }]} />
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* iOS Glass Background Gradient */}
      {isIOS && (
        <LinearGradient
          colors={['#1A1D21', '#252A30', '#1F2328', '#1A1D21']}
          locations={[0, 0.3, 0.7, 1]}
          style={styles.backgroundGradient}
        />
      )}
      
      {/* Offline Banner */}
      {isConnected === false && (
        <View style={styles.offlineBanner}>
          <Ionicons name="wifi-outline" size={16} color={colors.background} />
          <Text style={styles.offlineBannerText}>{locale === 'es' ? 'Modo sin conexión — Mostrando datos en caché' : 'Offline Mode — Showing cached data'}</Text>
        </View>
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.dateContainer}>
            <Ionicons name="calendar" size={36} color={colors.primary} />
            <View style={styles.dateTextContainer}>
              <Text style={styles.todayLabel}>{locale === 'es' ? 'Hoy' : 'Today'}</Text>
              <Text style={styles.dateText}>{formatHeaderDate()}</Text>
            </View>
          </View>
          <View style={styles.headerDivider} />
          <View style={styles.weatherContainer}>
            {weatherLoading ? (
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            ) : weather ? (
              <>
                <Ionicons name={weather.icon} size={28} color={weather.iconColor} />
                <View>
                  <Text style={styles.weatherLabel}>{weather.description}</Text>
                  <Text style={styles.weatherText}>{weather.temperature}°F</Text>
                </View>
              </>
            ) : (
              <>
                <Ionicons name="cloud-offline" size={28} color={colors.foregroundMuted} />
                <View>
                  <Text style={styles.weatherLabel}>{locale === 'es' ? 'Clima' : 'Weather'}</Text>
                  <Text style={styles.weatherText}>N/A</Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Section Header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{locale === 'es' ? 'Cargas Programadas' : 'Scheduled Loads'}</Text>
          <View style={styles.sectionActions}>
            <TouchableOpacity style={styles.actionButton}>
              <Feather name="filter" size={16} color={colors.foreground} />
              <Text style={styles.actionText}>{locale === 'es' ? 'Ordenar' : 'Sort'}</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => setShowCompleted(!showCompleted)}
            >
              <Ionicons name="checkmark-circle" size={18} color={colors.foreground} />
              <Text style={styles.actionText}>{locale === 'es' ? 'Completadas' : 'Completed'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Pending Sync */}
        {pendingCount > 0 && (
          <View style={styles.syncBanner}>
            <Ionicons name="cloud-upload-outline" size={16} color={colors.foregroundMuted} />
            <Text style={styles.syncText}>
              {locale === 'es' 
                ? `${pendingCount} actualización${pendingCount > 1 ? 'es' : ''} pendiente${pendingCount > 1 ? 's' : ''} de sincronizar`
                : `${pendingCount} update${pendingCount > 1 ? 's' : ''} pending sync`}
            </Text>
          </View>
        )}

        {/* Loading State */}
        {isLoading && <LoadingSkeleton />}

        {/* Current Load Card - iOS Glass Effect */}
        {!isLoading && activeLoad && (
          <TouchableOpacity
            style={styles.currentLoadCardWrapper}
            onPress={() => router.push(`/trip/${activeLoad._id}`)}
            activeOpacity={0.9}
          >
            {isIOS ? (
              <BlurView intensity={80} tint="systemChromeMaterialLight" style={styles.currentLoadCard}>
                <View style={styles.currentLoadContent}>
                  <View style={styles.currentLoadLeft}>
                    <MaterialCommunityIcons name="truck-delivery" size={32} color={colors.primaryForeground} />
                    <View>
                      <Text style={styles.currentLoadLabel}>{locale === 'es' ? 'Carga Actual' : 'Current Load'}</Text>
                      <Text style={styles.currentLoadId}>#{activeLoad.internalId}</Text>
                    </View>
                  </View>
                  <View style={styles.currentLoadRight}>
                    <Text style={styles.currentLoadExpectedLabel}>{locale === 'es' ? 'Esperado' : 'Expected'}</Text>
                    <Text style={styles.currentLoadTime}>
                      {formatTime(activeLoad.lastDelivery?.windowEndTime) || 'TBD'}
                    </Text>
                  </View>
                </View>
              </BlurView>
            ) : (
              <View style={styles.currentLoadCardAndroid}>
                <View style={styles.currentLoadContent}>
                  <View style={styles.currentLoadLeft}>
                    <MaterialCommunityIcons name="truck-delivery" size={32} color={colors.primaryForeground} />
                    <View>
                      <Text style={styles.currentLoadLabel}>{locale === 'es' ? 'Carga Actual' : 'Current Load'}</Text>
                      <Text style={styles.currentLoadId}>#{activeLoad.internalId}</Text>
                    </View>
                  </View>
                  <View style={styles.currentLoadRight}>
                    <Text style={styles.currentLoadExpectedLabel}>{locale === 'es' ? 'Esperado' : 'Expected'}</Text>
                    <Text style={styles.currentLoadTime}>
                      {formatTime(activeLoad.lastDelivery?.windowEndTime) || 'TBD'}
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </TouchableOpacity>
        )}

        {/* Scheduled Load Cards */}
        {!isLoading && scheduledLoads.map((load) => {
          const multiDay = isMultiDay(load);
          const multiDayDate = getMultiDayDate(load);
          const expectedDelivery = formatExpectedDelivery(load);
          
          return (
            <TouchableOpacity
              key={load._id}
              style={styles.loadCard}
              onPress={() => router.push(`/trip/${load._id}`)}
              activeOpacity={0.8}
            >
              {/* Card Header */}
              <View style={styles.loadCardHeader}>
                <View style={styles.loadCardHeaderLeft}>
                  <Feather name="package" size={14} color={colors.foregroundMuted} />
                  <Text style={styles.loadCardTitle}>Load #{load.internalId}</Text>
                </View>
                <View style={styles.statusBadge}>
                  <Text style={styles.statusBadgeText} maxFontSizeMultiplier={1.2}>{locale === 'es' ? 'Programada' : 'Scheduled'}</Text>
                </View>
              </View>
              
              {/* Badge Row */}
              {(load.parsedHcr || load.parsedTripNumber) && (
                <View style={styles.badgeRow}>
                  {load.parsedHcr && (
                    <View style={styles.truckBadge}>
                      <Text style={styles.truckBadgeText} maxFontSizeMultiplier={1.2}>{load.parsedHcr}</Text>
                    </View>
                  )}
                  {load.parsedTripNumber && (
                    <View style={styles.tripBadge}>
                      <Text style={styles.tripBadgeText} maxFontSizeMultiplier={1.2}>Trip {load.parsedTripNumber}</Text>
                    </View>
                  )}
                </View>
              )}

              {/* Multi-Day Indicator */}
              {multiDay && multiDayDate && (
                <View style={styles.multiDayBanner}>
                  <Ionicons name="calendar-outline" size={16} color={colors.chart3} />
                  <View>
                    <Text style={styles.multiDayTitle}>{locale === 'es' ? 'Carga Multi-Día' : 'Multi-Day Load'}</Text>
                    <Text style={styles.multiDayText}>{locale === 'es' ? `Continúa hasta ${multiDayDate}` : `Continues into ${multiDayDate}`}</Text>
                  </View>
                </View>
              )}

              {/* Time and Packages */}
              <View style={styles.loadCardStats}>
                <View style={styles.statLeft}>
                  <Text style={styles.statLabel}>{t('driverHome.pickup')}</Text>
                  <Text style={styles.statValue}>
                    {formatDateTime(load.firstPickup?.windowBeginDate, load.firstPickup?.windowBeginTime) || 'TBD'}
                  </Text>
                </View>
                <View style={styles.statRight}>
                  <Text style={styles.statLabel}>{locale === 'es' ? 'Paradas' : 'Stops'}</Text>
                  <Text style={styles.statValueMono}>{load.stopCount || '—'}</Text>
                </View>
              </View>

              {/* Addresses */}
              <View style={styles.addressSection}>
                {/* Pickup */}
                <View style={styles.addressRow}>
                  <Ionicons name="location" size={16} color={colors.chart4} style={{ marginTop: 2 }} />
                  <View style={styles.addressContent}>
                    <Text style={styles.addressLabel}>{t('driverHome.pickup')}</Text>
                    <Text style={styles.addressText}>{getPickupAddress(load)}</Text>
                  </View>
                </View>

                {/* Delivery */}
                <View style={styles.addressRow}>
                  <Ionicons name="flag" size={16} color={colors.destructive} style={{ marginTop: 2 }} />
                  <View style={styles.addressContent}>
                    <Text style={styles.addressLabel}>{locale === 'es' ? 'Última Entrega' : 'Last Delivery'}</Text>
                    <Text style={styles.addressText}>{getDeliveryAddress(load)}</Text>
                    {expectedDelivery && (
                      <Text style={styles.expectedText}>{locale === 'es' ? 'Esperado' : 'Expected'}: {expectedDelivery}</Text>
                    )}
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* No Loads State */}
        {!isLoading && !activeLoad && scheduledLoads.length === 0 && (
          <View style={styles.emptyStateCard}>
            <View style={styles.emptyStateIconContainer}>
              <Ionicons name="clipboard-outline" size={32} color={colors.foregroundMuted} />
            </View>
            <Text style={styles.emptyStateTitle}>{t('driverHome.noActiveLoads')}</Text>
            <Text style={styles.emptyStateSubtitle}>
              {t('driverHome.noActiveLoadsDesc')}
            </Text>
          </View>
        )}

        {/* Completed Loads */}
        {showCompleted && completedLoads.length > 0 && (
          <>
            <View style={styles.completedHeader}>
              <Text style={styles.completedHeaderText}>
                {locale === 'es' ? 'Completadas' : 'Completed'} ({completedLoads.length})
              </Text>
            </View>
            {completedLoads.map((load) => (
              <TouchableOpacity
                key={load._id}
                style={styles.completedCard}
                onPress={() => router.push(`/trip/${load._id}`)}
                activeOpacity={0.7}
              >
                <View style={styles.completedContent}>
                  <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                  <View>
                    <Text style={styles.completedTitle}>Load #{load.internalId}</Text>
                    <Text style={styles.completedSubtitle}>
                      {load.lastDelivery?.city || 'Completed'}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* Bottom spacing for nav */}
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================
// DARK THEME STYLES
// ============================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  backgroundGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.md,
  },

  // Offline Banner
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.warning,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    gap: 8,
  },
  offlineBannerText: {
    color: colors.background,
    fontSize: typography.sm,
    fontWeight: typography.semibold,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  dateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  dateTextContainer: {
    flex: 1,
  },
  todayLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  dateText: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  headerDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
    marginHorizontal: spacing.base,
  },
  weatherContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  weatherLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: colors.foregroundMuted,
  },
  weatherText: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: isIOS ? typography.lg : typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
    flexShrink: 1,
  },
  sectionActions: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 0,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: isIOS ? 'rgba(45, 50, 59, 0.7)' : colors.muted,
    paddingHorizontal: isIOS ? 10 : 12,
    paddingVertical: isIOS ? 6 : 8,
    borderRadius: borderRadius.lg,
    borderWidth: isIOS ? 1 : 0,
    borderColor: isIOS ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
  },
  actionText: {
    fontSize: isIOS ? typography.xs : typography.sm,
    fontWeight: typography.medium,
    color: colors.foreground,
  },

  // Sync Banner
  syncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.muted,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  syncText: {
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    fontWeight: typography.medium,
  },

  // Current Load Card
  currentLoadCardWrapper: {
    marginBottom: spacing.md,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    // iOS glass styling
    ...(isIOS && {
      backgroundColor: 'rgba(255, 107, 0, 0.85)',
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.2)',
    }),
    ...shadows.lg,
  },
  currentLoadCard: {
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    overflow: 'hidden',
  },
  currentLoadCardAndroid: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
  },
  currentLoadContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  currentLoadLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  currentLoadLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.8)',
  },
  currentLoadId: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.primaryForeground,
    fontFamily: 'Courier',
    letterSpacing: -1,
  },
  currentLoadRight: {
    alignItems: 'flex-end',
  },
  currentLoadExpectedLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.8)',
  },
  currentLoadTime: {
    fontSize: typography['2xl'],
    fontWeight: typography.semibold,
    color: colors.primaryForeground,
  },

  // Load Card - iOS Glass Effect
  loadCard: {
    backgroundColor: isIOS ? 'rgba(34, 38, 43, 0.65)' : colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.base,
    marginBottom: spacing.base,
    borderWidth: 1,
    borderColor: isIOS ? 'rgba(255, 255, 255, 0.1)' : 'rgba(63, 69, 82, 0.5)',
    ...shadows.md,
  },
  loadCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  loadCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  loadCardTitle: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  truckBadge: {
    backgroundColor: 'rgba(255, 107, 0, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.md,
  },
  truckBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.primary,
  },
  tripBadge: {
    backgroundColor: 'rgba(59, 130, 246, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.md,
  },
  tripBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.chart3,
  },
  statusBadge: {
    backgroundColor: isIOS ? 'rgba(234, 179, 8, 0.4)' : 'rgba(234, 179, 8, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    borderWidth: isIOS ? 1 : 0,
    borderColor: isIOS ? 'rgba(234, 179, 8, 0.6)' : 'transparent',
  },
  statusBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.secondary,
  },

  // Multi-Day Banner
  multiDayBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: borderRadius.lg,
    marginBottom: 8,
  },
  multiDayTitle: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.chart3,
  },
  multiDayText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },

  // Stats
  loadCardStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  statValue: {
    fontSize: typography.lg,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  statLeft: {
    flex: 1,
  },
  statRight: {
    alignItems: 'flex-end',
  },
  statValueMono: {
    fontSize: typography.lg,
    fontWeight: typography.bold,
    color: colors.foreground,
    fontFamily: 'Courier',
  },

  // Address Section
  addressSection: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(63, 69, 82, 0.5)',
    paddingTop: 8,
    gap: 8,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  addressContent: {
    flex: 1,
  },
  addressLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  addressText: {
    fontSize: typography.base,
    fontWeight: typography.medium,
    color: colors.foreground,
  },
  expectedText: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: colors.chart3,
    marginTop: 4,
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
    fontWeight: typography.semibold,
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

  // Completed Section
  completedHeader: {
    marginTop: spacing.lg,
    marginBottom: spacing.base,
  },
  completedHeaderText: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foregroundMuted,
  },
  completedCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.base,
    marginBottom: 8,
    opacity: 0.7,
  },
  completedContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  completedTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  completedSubtitle: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },

  // Skeleton
  skeletonContainer: {
    paddingTop: spacing.md,
  },
  skeletonBox: {
    backgroundColor: colors.muted,
    borderRadius: borderRadius.xl,
  },
});
