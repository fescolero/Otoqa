import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useMyLoads } from '../../../lib/hooks/useMyLoads';
import { useNetworkStatus } from '../../../lib/hooks/useNetworkStatus';
import { useOfflineQueue } from '../../../lib/hooks/useOfflineQueue';
import { useDriver } from '../_layout';
import { colors, typography, spacing, borderRadius, shadows, isIOS } from '../../../lib/theme';
import { useLanguage } from '../../../lib/LanguageContext';
import { LinearGradient } from 'expo-linear-gradient';
import { trackWeatherFetchFailed, trackScreen } from '../../../lib/analytics';
import { stopSessionTracking } from '../../../lib/location-tracking';

// Soft caps for shift tracking — banner thresholds, never enforced.
const SOFT_CAP_10H_MS = 10 * 60 * 60 * 1000;
const SOFT_CAP_14H_MS = 14 * 60 * 60 * 1000;

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

type DayTab = 'yesterday' | 'today' | 'tomorrow';

function getDateStringForDay(day: DayTab): string {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (day === 'yesterday') target.setDate(target.getDate() - 1);
  if (day === 'tomorrow') target.setDate(target.getDate() + 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
}

function getLoadPickupDate(load: any): string | null {
  const dateStr = load?.firstPickup?.windowBeginDate || load?.firstStopDate;
  if (!dateStr) return null;
  return dateStr.split('T')[0];
}

const DAY_TABS: { key: DayTab; labelEn: string; labelEs: string }[] = [
  { key: 'yesterday', labelEn: 'Yesterday', labelEs: 'Ayer' },
  { key: 'today', labelEn: 'Today', labelEs: 'Hoy' },
  { key: 'tomorrow', labelEn: 'Tomorrow', labelEs: 'Mañana' },
];

export default function HomeScreen() {
  const router = useRouter();
  const { driverId } = useDriver();
  const {
    loads,
    isLoading,
    refetch,
    isRefetching,
    mode,
    activeSession,
    sessionLoads,
  } = useMyLoads(driverId);
  const { connectionQuality } = useNetworkStatus();
  const { pendingCount } = useOfflineQueue();
  const { t, locale } = useLanguage();

  // Driver Session System (Phase 3): End Shift mutation. Wrapped here so we
  // can also tear down GPS tracking after the server-side session closes.
  const endSessionMutation = useMutation(api.driverSessions.endSession);
  // Phase 4: stamp soft-cap timestamps when banners cross threshold so the
  // dispatcher dashboard (Phase 6) can surface drivers who've been on shift
  // too long. Mutation is idempotent server-side.
  const markSoftCapHit = useMutation(api.driverSessions.markSoftCapHit);
  const [isEndingShift, setIsEndingShift] = useState(false);

  const isSessionMode = mode === 'session';

  const [selectedDay, setSelectedDay] = useState<DayTab>('today');

  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);

  // Fetch weather based on user location
  const fetchWeather = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      setWeatherLoading(true);
      
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (signal?.cancelled) return;
      if (status !== 'granted') {
        setWeatherLoading(false);
        return;
      }
      
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (signal?.cancelled) return;
      
      const { latitude, longitude } = location.coords;
      
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`
      );
      if (signal?.cancelled) return;
      
      if (!response.ok) {
        throw new Error('Weather fetch failed');
      }
      
      const data = await response.json();
      if (signal?.cancelled) return;
      
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
      if (signal?.cancelled) return;
      const msg = error instanceof Error ? error.message : String(error);
      trackWeatherFetchFailed(msg);
      console.error('Error fetching weather:', error);
    } finally {
      if (!signal?.cancelled) setWeatherLoading(false);
    }
  }, []);

  // Fetch weather and track screen on mount
  useEffect(() => {
    const signal = { cancelled: false };
    trackScreen('Home');
    fetchWeather(signal);
    return () => { signal.cancelled = true; };
  }, [fetchWeather]);

  // Enhanced refetch that includes weather
  const handleRefresh = useCallback(async () => {
    await Promise.all([refetch(), fetchWeather()]);
  }, [refetch, fetchWeather]);

  const selectedDateStr = useMemo(() => getDateStringForDay(selectedDay), [selectedDay]);

  // Bucket loads for rendering. Session mode uses server-bucketed data
  // directly (In Progress / Up Next / Completed-this-session). Calendar
  // mode (legacy, no active session) keeps the existing day-tab logic.
  const { activeLoad, scheduledLoads, completedLoads } = useMemo(() => {
    if (isSessionMode) {
      if (!sessionLoads) {
        return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
      }
      // Backend already sorted upNext by plannedStartAt and limited
      // inProgress to the ACTIVE leg(s). No calendar filter applies.
      return {
        activeLoad: sessionLoads.inProgress[0] ?? null,
        scheduledLoads: sessionLoads.upNext,
        completedLoads: sessionLoads.completedThisSession,
      };
    }

    if (!loads || loads.length === 0) {
      return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
    }

    const completed = loads.filter((l) => l.status === 'Completed' || l.trackingStatus === 'Completed');
    const active = loads.filter((l) => l.status !== 'Completed' && l.trackingStatus !== 'Completed');

    const inProgress = active.find(
      (l) => l.trackingStatus === 'In Transit' ||
             l.trackingStatus === 'At Pickup' ||
             l.trackingStatus === 'At Delivery' ||
             l.status === 'In Progress'
    );

    const scheduled = active
      .filter((l) => l._id !== inProgress?._id)
      .filter((l) => getLoadPickupDate(l) === selectedDateStr)
      .sort((a, b) => {
        const timeA = a.firstPickup?.windowBeginDate || '';
        const timeB = b.firstPickup?.windowBeginDate || '';
        return timeA.localeCompare(timeB);
      });

    const filteredCompleted = completed.filter((l) => getLoadPickupDate(l) === selectedDateStr);

    return {
      activeLoad: inProgress,
      scheduledLoads: scheduled,
      completedLoads: filteredCompleted,
    };
  }, [isSessionMode, sessionLoads, loads, selectedDateStr]);

  // Session elapsed time + soft-cap state (drives the chrome/banner). Tick
  // every minute; banners are render-time, not stored on the session doc.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isSessionMode) return;
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [isSessionMode]);
  const elapsedMs = activeSession ? nowTick - activeSession.startedAt : 0;
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const elapsedMinutes = Math.floor((elapsedMs % (60 * 60 * 1000)) / 60_000);
  const overSoftCap10h = elapsedMs >= SOFT_CAP_10H_MS;
  const overSoftCap14h = elapsedMs >= SOFT_CAP_14H_MS;

  // Stamp soft-cap timestamps server-side once per session per cap. Server
  // is idempotent (only stamps if the field is null), so re-firing on every
  // tick is safe — but we also gate via activeSession's existing softCap*At
  // fields to avoid pointless mutations.
  useEffect(() => {
    if (!activeSession || !isSessionMode) return;
    if (overSoftCap10h && !activeSession.softCap10hAt) {
      markSoftCapHit({ sessionId: activeSession._id, cap: '10h' }).catch((e) =>
        console.warn('[HomeScreen] markSoftCapHit(10h) failed:', e),
      );
    }
    if (overSoftCap14h && !activeSession.softCap14hAt) {
      markSoftCapHit({ sessionId: activeSession._id, cap: '14h' }).catch((e) =>
        console.warn('[HomeScreen] markSoftCapHit(14h) failed:', e),
      );
    }
  }, [
    isSessionMode,
    activeSession?._id,
    activeSession?.softCap10hAt,
    activeSession?.softCap14hAt,
    overSoftCap10h,
    overSoftCap14h,
    markSoftCapHit,
  ]);

  // End Shift handler. Blocks via dialog if any leg is in progress (the
  // backend will end them anyway, but we want the driver to confirm or
  // contact dispatch for a handoff first).
  const handleEndShift = useCallback(async () => {
    if (!activeSession || isEndingShift) return;
    const inProgressCount = sessionLoads?.inProgress.length ?? 0;

    const proceed = async () => {
      setIsEndingShift(true);
      try {
        await endSessionMutation({
          sessionId: activeSession._id,
          endReason: 'driver_manual',
        });
        await stopSessionTracking();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to end shift';
        Alert.alert('Could Not End Shift', msg);
      } finally {
        setIsEndingShift(false);
      }
    };

    if (inProgressCount > 0) {
      Alert.alert(
        'Load In Progress',
        'You have a load in progress. Contact dispatch to reassign before ending your shift, or end anyway and the load will be flagged for dispatcher review.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'End Anyway', style: 'destructive', onPress: proceed },
        ],
      );
      return;
    }

    Alert.alert('End Shift?', 'GPS tracking will stop. You can start a new shift any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End Shift', onPress: proceed },
    ]);
  }, [activeSession, sessionLoads, isEndingShift, endSessionMutation]);

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
      
      {/* Connection Quality Banners */}
      {connectionQuality === 'offline' && (
        <View style={styles.offlineBanner}>
          <Ionicons name="wifi-outline" size={16} color={colors.background} />
          <Text style={styles.offlineBannerText}>
            {locale === 'es' ? 'Sin conexión — Mostrando datos en caché' : 'Offline — Showing cached data'}
            {pendingCount > 0 ? ` (${pendingCount} ${locale === 'es' ? 'pendientes' : 'pending'})` : ''}
          </Text>
        </View>
      )}
      {connectionQuality === 'poor' && (
        <View style={[styles.offlineBanner, { backgroundColor: colors.secondary }]}>
          <Ionicons name="cellular" size={16} color={colors.background} />
          <Text style={styles.offlineBannerText}>
            {locale === 'es' ? 'Señal débil — Usando datos en caché' : 'Weak signal — Using cached data'}
            {pendingCount > 0 ? ` (${pendingCount} ${locale === 'es' ? 'pendientes' : 'pending'})` : ''}
          </Text>
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

        {/* Session-mode header chrome — shown only when a shift is active */}
        {isSessionMode && activeSession && (
          <View style={sessionStyles.sessionHeader}>
            <View style={sessionStyles.sessionHeaderRow}>
              <View style={sessionStyles.sessionHeaderTextWrap}>
                <Text style={sessionStyles.sessionHeaderTitle}>
                  {locale === 'es' ? 'Turno Activo' : 'Shift Active'}
                </Text>
                <Text style={sessionStyles.sessionHeaderSub}>
                  {`${elapsedHours}h ${elapsedMinutes}m`}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  sessionStyles.endShiftButton,
                  pressed && { opacity: 0.85 },
                  isEndingShift && { opacity: 0.6 },
                ]}
                disabled={isEndingShift}
                onPress={handleEndShift}
              >
                <Ionicons name="stop-circle-outline" size={18} color={colors.background} />
                <Text style={sessionStyles.endShiftButtonText}>
                  {isEndingShift
                    ? locale === 'es'
                      ? 'Terminando...'
                      : 'Ending...'
                    : locale === 'es'
                      ? 'Terminar Turno'
                      : 'End Shift'}
                </Text>
              </Pressable>
            </View>
            {overSoftCap14h && (
              <View style={[sessionStyles.softCapBanner, sessionStyles.softCapBanner14h]}>
                <Ionicons name="warning" size={14} color="#fff" />
                <Text style={sessionStyles.softCapBannerText}>
                  {locale === 'es'
                    ? 'Has trabajado más de 14 horas. Considera terminar tu turno.'
                    : "You've been on shift over 14 hours. Consider ending your shift."}
                </Text>
              </View>
            )}
            {!overSoftCap14h && overSoftCap10h && (
              <View style={[sessionStyles.softCapBanner, sessionStyles.softCapBanner10h]}>
                <Ionicons name="time-outline" size={14} color="#fff" />
                <Text style={sessionStyles.softCapBannerText}>
                  {locale === 'es'
                    ? 'Llevas 10 horas en tu turno.'
                    : "You've been on shift 10 hours."}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Day Switcher — calendar mode only. Session mode is shift-bounded. */}
        {!isSessionMode && (
          <View style={styles.daySwitcher}>
            {DAY_TABS.map(({ key, labelEn, labelEs }) => (
              <Pressable
                key={key}
                style={[styles.dayTab, selectedDay === key && styles.dayTabActive]}
                onPress={() => setSelectedDay(key)}
              >
                <Text style={[styles.dayTabText, selectedDay === key && styles.dayTabTextActive]}>
                  {locale === 'es' ? labelEs : labelEn}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Section Header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {isSessionMode
              ? locale === 'es'
                ? 'Cargas de Este Turno'
                : 'Loads This Shift'
              : locale === 'es'
                ? selectedDay === 'today' ? 'Próximas Hoy' : selectedDay === 'yesterday' ? 'Ayer' : 'Mañana'
                : selectedDay === 'today' ? 'Upcoming Today' : selectedDay === 'yesterday' ? 'Yesterday' : 'Tomorrow'}
          </Text>
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

        {/* In Progress Card */}
        {!isLoading && activeLoad && (
          <>
            <View style={styles.inProgressLabel}>
              <Text style={styles.inProgressLabelText}>{locale === 'es' ? 'EN PROGRESO' : 'IN PROGRESS'}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.inProgressCard, pressed && { opacity: 0.9 }]}
              onPress={() => router.push(`/trip/${activeLoad._id}`)}
            >
              <View style={styles.inProgressLeft}>
                <Text style={styles.inProgressId}>#{activeLoad.internalId}</Text>
                <Text style={styles.inProgressSub}>
                  {[activeLoad.parsedHcr, activeLoad.trackingStatus === 'In Transit' ? 'On Route' : activeLoad.trackingStatus].filter(Boolean).join(' • ')}
                </Text>
              </View>
              <View style={styles.inProgressRight}>
                <Text style={styles.inProgressEtaTime}>
                  {formatTime(activeLoad.lastDelivery?.windowEndTime) || 'TBD'}
                </Text>
                <Text style={styles.inProgressEtaLabel}>ETA</Text>
              </View>
              <View style={styles.inProgressArrow}>
                <Ionicons name="arrow-forward" size={20} color={colors.primaryForeground} />
              </View>
            </Pressable>
          </>
        )}

        {/* Scheduled Load Cards */}
        {!isLoading && scheduledLoads.map((load) => {
          const multiDay = isMultiDay(load);
          const multiDayDate = getMultiDayDate(load);
          const expectedDelivery = formatExpectedDelivery(load);
          
          return (
            <Pressable
              key={load._id}
              style={({ pressed }) => [styles.loadCard, pressed && { opacity: 0.8 }]}
              onPress={() => router.push(`/trip/${load._id}`)}
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
            </Pressable>
          );
        })}

        {/* No Loads State */}
        {!isLoading && scheduledLoads.length === 0 && completedLoads.length === 0 && (
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

        {/* Completed Loads (last 2 days) */}
        {completedLoads.length > 0 && (
          <>
            <View style={styles.completedHeader}>
              <Text style={styles.completedHeaderText}>
                {locale === 'es' ? 'Completadas Recientes' : 'Recently Completed'} ({completedLoads.length})
              </Text>
            </View>
            {completedLoads.map((load) => (
              <Pressable
                key={load._id}
                style={({ pressed }) => [styles.completedCard, pressed && { opacity: 0.7 }]}
                onPress={() => router.push(`/trip/${load._id}`)}
              >
                <View style={styles.completedContent}>
                  <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.completedTitle}>Load #{load.internalId}</Text>
                    <Text style={styles.completedSubtitle}>
                      {[load.firstPickup?.city, load.lastDelivery?.city].filter(Boolean).join(' → ') || 'Completed'}
                    </Text>
                  </View>
                  {load.firstStopDate && (
                    <Text style={styles.completedDate}>
                      {(() => {
                        try {
                          const [y, m, d] = load.firstStopDate.split('-');
                          const date = new Date(Number(y), Number(m) - 1, Number(d));
                          return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        } catch { return ''; }
                      })()}
                    </Text>
                  )}
                </View>
              </Pressable>
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

  // Day Switcher
  daySwitcher: {
    flexDirection: 'row',
    backgroundColor: colors.muted,
    borderRadius: borderRadius.xl,
    padding: 3,
    marginBottom: spacing.md,
  },
  dayTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: borderRadius.lg,
  },
  dayTabActive: {
    backgroundColor: colors.card,
  },
  dayTabText: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.foregroundMuted,
  },
  dayTabTextActive: {
    color: colors.foreground,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: isIOS ? typography.lg : typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
    flexShrink: 1,
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

  // In Progress Card
  inProgressLabel: {
    marginBottom: spacing.xs,
  },
  inProgressLabelText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.foregroundMuted,
    letterSpacing: 1,
  },
  inProgressCard: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.base,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inProgressLeft: {
    flex: 1,
  },
  inProgressId: {
    fontSize: typography.xl,
    fontWeight: typography.bold,
    color: colors.primaryForeground,
  },
  inProgressSub: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.7)',
    marginTop: 2,
  },
  inProgressRight: {
    alignItems: 'flex-end',
    marginRight: spacing.base,
  },
  inProgressEtaTime: {
    fontSize: typography.xl,
    fontWeight: typography.bold,
    color: colors.primaryForeground,
  },
  inProgressEtaLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.7)',
  },
  inProgressArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(26, 29, 33, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
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
  completedDate: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    fontWeight: typography.medium,
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

// Driver Session System (Phase 3) — session header + soft-cap banners.
// Kept as a separate StyleSheet so the legacy styles object stays intact.
const sessionStyles = StyleSheet.create({
  sessionHeader: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sessionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sessionHeaderTextWrap: {
    flex: 1,
  },
  sessionHeaderTitle: {
    ...typography.h3,
    color: colors.foreground,
  },
  sessionHeaderSub: {
    ...typography.caption,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  endShiftButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.destructive,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    gap: spacing.xs,
  },
  endShiftButtonText: {
    ...typography.body,
    color: colors.background,
    fontWeight: '600',
  },
  softCapBanner: {
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  softCapBanner10h: {
    backgroundColor: '#D97706', // amber-600
  },
  softCapBanner14h: {
    backgroundColor: '#DC2626', // red-600
  },
  softCapBannerText: {
    ...typography.caption,
    color: '#fff',
    fontWeight: '500',
    flex: 1,
  },
});
