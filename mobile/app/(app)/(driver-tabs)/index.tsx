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
import * as Location from 'expo-location';
import { useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useMyLoads } from '../../../lib/hooks/useMyLoads';
import { useNetworkStatus } from '../../../lib/hooks/useNetworkStatus';
import { useOfflineQueue } from '../../../lib/hooks/useOfflineQueue';
import { useDriver } from '../_layout';
import { useLanguage } from '../../../lib/LanguageContext';
import { trackWeatherFetchFailed, trackScreen } from '../../../lib/analytics';
import { stopSessionTracking } from '../../../lib/location-tracking';
import { Icon, type IconName } from '../../../lib/design-icons';
import {
  typeScale,
  densitySpacing,
  densityComponents,
  radii,
  spacing,
  tagStyles,
  tagFallback,
  type Palette,
} from '../../../lib/design-tokens';
import { useTheme } from '../../../lib/ThemeContext';

// ============================================================================
// DRIVER DASHBOARD — Otoqa Driver design
//
// Two modes:
//   - Session mode:  driver started a shift. No day tabs; header shows shift
//     status + End Shift. Loads derive from sessionLoads buckets.
//   - Calendar mode: no active session. Yesterday/Today/Tomorrow tabs drive
//     the load list.
//
// Locked to the dark palette for now — drivers use the app in-vehicle where
// dark mode reduces glare. Flip to `palettes[useColorScheme()]` later if we
// surface a theme preference.
// ============================================================================

const density = 'dense'; // Drivers see more rows with dense; keeps 44pt hit targets.
const sp = densitySpacing[density];
const comp = densityComponents[density];

/**
 * Tiny wrapper so sub-components inside this file get `palette` + memoized
 * `styles` without each duplicating the hook-plus-useMemo boilerplate.
 */
function useDesignStyles() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return { palette, styles };
}

// Weather tooling
interface WeatherData {
  temperature: number;
  description: string;
}

// Map WMO weather codes to a plain description. Icons come from the design icon set.
const weatherDescription = (code: number): string => {
  if (code === 0 || code === 1) return 'Clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code >= 45 && code <= 48) return 'Foggy';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return '';
};

type DayTab = 'yesterday' | 'today' | 'tomorrow';

function getDateStringForDay(day: DayTab): string {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (day === 'yesterday') target.setDate(target.getDate() - 1);
  if (day === 'tomorrow') target.setDate(target.getDate() + 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
}

function getDayLabel(day: DayTab): string {
  const d = new Date();
  if (day === 'yesterday') d.setDate(d.getDate() - 1);
  if (day === 'tomorrow') d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getLoadPickupDate(load: any): string | null {
  const dateStr = load?.firstPickup?.windowBeginDate || load?.firstStopDate;
  if (!dateStr) return null;
  return dateStr.split('T')[0];
}

function formatTime(timeStr?: string): string | null {
  if (!timeStr) return null;
  try {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return null;
  }
}

// Build the display string list for a load's badges.
//
// Pulls from two sources:
//
//   1. The facet system (`facets` array from the server, or the legacy
//      parsedHcr / parsedTripNumber pair if the response pre-dates the
//      facet migration). TRIP values get a "Trip " prefix so the badge
//      reads "Trip 12345" instead of a bare number.
//
//   2. Fields on the load document that classify it but aren't stored
//      as loadTags: equipment type (REEF / FLAT / DRY / …), isHazmat
//      (HAZ), requiresTarp (TARP). Without these, loads that never got
//      HCR/TRIP tags written show up with no badges at all.
//
// Result is de-duped while preserving order.
function loadFacetTags(load: {
  facets?: Array<{ key: string; value: string }>;
  parsedHcr?: string;
  parsedTripNumber?: string;
  equipmentType?: string;
  isHazmat?: boolean;
  requiresTarp?: boolean;
}): string[] {
  const tags: string[] = [];

  if (load.facets && load.facets.length > 0) {
    for (const { key, value } of load.facets) {
      if (!value || !value.trim()) continue;
      tags.push(key === 'TRIP' ? `Trip ${value}` : value);
    }
  } else {
    if (load.parsedHcr) tags.push(load.parsedHcr);
    if (load.parsedTripNumber) tags.push(`Trip ${load.parsedTripNumber}`);
  }

  const eq = equipmentShortCode(load.equipmentType);
  if (eq) tags.push(eq);
  if (load.isHazmat) tags.push('HAZ');
  if (load.requiresTarp) tags.push('TARP');

  return Array.from(new Set(tags));
}

// Shorten equipment types into the 3-4 char tokens the design's
// TAG_STYLES palette is keyed on (REEF, DRY, FLAT, …). Unknown types
// fall back to the uppercased source string so nothing is silently
// dropped.
function equipmentShortCode(raw?: string): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (!up) return null;
  if (up.includes('REEF')) return 'REEF';
  if (up.includes('FLAT')) return 'FLAT';
  if (up.includes('DRY')) return 'DRY';
  if (up.includes('STEP')) return 'STEP';
  if (up.includes('TANK')) return 'TANK';
  if (up.includes('CONEST')) return 'CONE';
  if (up.includes('LTL')) return 'LTL';
  if (up.includes('OVERSIZE') || up.includes('OVR')) return 'OVR';
  return up.slice(0, 6);
}

// Soft caps for shift duration — banners only, never forced actions.
const SOFT_CAP_10H_MS = 10 * 60 * 60 * 1000;
const SOFT_CAP_14H_MS = 14 * 60 * 60 * 1000;

// Time-of-day greeting per design
const greet = (): string => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

// ============================================================================
// SCREEN
// ============================================================================

export default function HomeScreen() {
  const router = useRouter();
  const { palette, styles } = useDesignStyles();
  const { driverId, driverName } = useDriver();
  const firstName = driverName.trim().split(/\s+/)[0] || 'Driver';
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

  const endSessionMutation = useMutation(api.driverSessions.endSession);
  const markSoftCapHit = useMutation(api.driverSessions.markSoftCapHit);
  const [isEndingShift, setIsEndingShift] = useState(false);

  const isSessionMode = mode === 'session';
  const [selectedDay, setSelectedDay] = useState<DayTab>('today');

  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);

  const fetchWeather = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (signal?.cancelled) return;
      if (status !== 'granted') return;

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (signal?.cancelled) return;

      const { latitude, longitude } = location.coords;
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`
      );
      if (signal?.cancelled) return;
      if (!response.ok) throw new Error('Weather fetch failed');

      const data = await response.json();
      if (signal?.cancelled) return;

      if (data.current) {
        setWeather({
          temperature: Math.round(data.current.temperature_2m),
          description: weatherDescription(data.current.weather_code),
        });
      }
    } catch (error) {
      if (signal?.cancelled) return;
      const msg = error instanceof Error ? error.message : String(error);
      trackWeatherFetchFailed(msg);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    trackScreen('Home');
    fetchWeather(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchWeather]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([refetch(), fetchWeather()]);
  }, [refetch, fetchWeather]);

  const selectedDateStr = useMemo(() => getDateStringForDay(selectedDay), [selectedDay]);

  const { activeLoad, scheduledLoads, completedLoads } = useMemo(() => {
    if (isSessionMode) {
      if (!sessionLoads) return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
      return {
        activeLoad: sessionLoads.inProgress[0] ?? null,
        scheduledLoads: sessionLoads.upNext,
        completedLoads: sessionLoads.completedThisSession,
      };
    }

    if (!loads || loads.length === 0) {
      return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
    }

    const completed = loads.filter(
      (l) => l.status === 'Completed' || l.trackingStatus === 'Completed'
    );
    const active = loads.filter(
      (l) => l.status !== 'Completed' && l.trackingStatus !== 'Completed'
    );

    const inProgress = active.find(
      (l) =>
        l.trackingStatus === 'In Transit' ||
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

    const filteredCompleted = completed.filter(
      (l) => getLoadPickupDate(l) === selectedDateStr
    );

    return {
      activeLoad: inProgress,
      scheduledLoads: scheduled,
      completedLoads: filteredCompleted,
    };
  }, [isSessionMode, sessionLoads, loads, selectedDateStr]);

  // Session elapsed time tick (every minute). Banners are render-time, not
  // stored on the session doc — softCap*At fields on the session are
  // stamped by the markSoftCapHit mutation side-effect below.
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

  useEffect(() => {
    if (!activeSession || !isSessionMode) return;
    if (overSoftCap10h && !activeSession.softCap10hAt) {
      markSoftCapHit({ sessionId: activeSession._id, cap: '10h' }).catch((e) =>
        console.warn('[HomeScreen] markSoftCapHit(10h) failed:', e)
      );
    }
    if (overSoftCap14h && !activeSession.softCap14hAt) {
      markSoftCapHit({ sessionId: activeSession._id, cap: '14h' }).catch((e) =>
        console.warn('[HomeScreen] markSoftCapHit(14h) failed:', e)
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
        ]
      );
      return;
    }

    Alert.alert(
      'End Shift?',
      'GPS tracking will stop. You can start a new shift any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End Shift', onPress: proceed },
      ]
    );
  }, [activeSession, sessionLoads, isEndingShift, endSessionMutation]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {connectionQuality === 'offline' && (
        <ConnectionBanner
          label={
            locale === 'es'
              ? 'Sin conexión — Mostrando datos en caché'
              : 'Offline — Showing cached data'
          }
          pending={pendingCount}
          pendingLabel={locale === 'es' ? 'pendientes' : 'pending'}
          tone="danger"
        />
      )}
      {connectionQuality === 'poor' && (
        <ConnectionBanner
          label={
            locale === 'es'
              ? 'Señal débil — Usando datos en caché'
              : 'Weak signal — Using cached data'
          }
          pending={pendingCount}
          pendingLabel={locale === 'es' ? 'pendientes' : 'pending'}
          tone="warning"
        />
      )}

      <TopHeader
        greeting={greet()}
        driverFirstName={firstName}
        isSessionMode={isSessionMode}
        elapsedHours={elapsedHours}
        elapsedMinutes={elapsedMinutes}
        onEndShift={handleEndShift}
        isEndingShift={isEndingShift}
        weather={weather}
      />

      {!isSessionMode && (
        <DayTabs tab={selectedDay} setTab={setSelectedDay} />
      )}

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={palette.accent}
            colors={[palette.accent]}
          />
        }
      >
        {isSessionMode && overSoftCap14h && (
          <SoftCapBanner level="14h" locale={locale} />
        )}
        {isSessionMode && !overSoftCap14h && overSoftCap10h && (
          <SoftCapBanner level="10h" locale={locale} />
        )}

        {isLoading && <LoadingSkeleton />}

        {!isLoading && activeLoad && (
          <ActiveLoadCard
            load={activeLoad}
            onPress={() => router.push(`/trip/${activeLoad._id}`)}
          />
        )}

        {!isLoading && scheduledLoads.length > 0 && (
          <UpcomingSection
            loads={scheduledLoads}
            isSessionMode={isSessionMode}
            onPress={(id) => router.push(`/trip/${id}`)}
          />
        )}

        {!isLoading && completedLoads.length > 0 && (
          <CompletedSection
            loads={completedLoads}
            isSessionMode={isSessionMode}
          />
        )}

        {!isLoading &&
          !activeLoad &&
          scheduledLoads.length === 0 &&
          completedLoads.length === 0 && (
            <EmptyState
              variant={isSessionMode ? 'session' : selectedDay}
              locale={locale}
              onRefresh={handleRefresh}
              isRefreshing={isRefetching}
            />
          )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// HEADER
// ============================================================================

interface TopHeaderProps {
  greeting: string;
  driverFirstName: string;
  isSessionMode: boolean;
  elapsedHours: number;
  elapsedMinutes: number;
  onEndShift: () => void;
  isEndingShift: boolean;
  weather: WeatherData | null;
}

const TopHeader: React.FC<TopHeaderProps> = ({
  greeting,
  driverFirstName,
  isSessionMode,
  elapsedHours,
  elapsedMinutes,
  onEndShift,
  isEndingShift,
  weather,
}) => {
  const { palette, styles } = useDesignStyles();
  return (
  <View style={styles.header}>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={styles.headerGreeting}>
        {isSessionMode ? 'Shift active' : greeting}
      </Text>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {isSessionMode ? `${elapsedHours}h ${elapsedMinutes}m on duty` : driverFirstName}
      </Text>
    </View>

    <View style={styles.headerActions}>
      {isSessionMode ? (
        <Pressable
          onPress={onEndShift}
          disabled={isEndingShift}
          accessibilityLabel="End shift"
          style={({ pressed }) => [
            styles.endShiftPill,
            pressed && { opacity: 0.85 },
            isEndingShift && { opacity: 0.6 },
          ]}
        >
          <Icon name="stop" size={14} color="#fff" strokeWidth={2} />
          <Text style={styles.endShiftPillText}>
            {isEndingShift ? 'Ending…' : 'End'}
          </Text>
        </Pressable>
      ) : (
        <>
          {weather && (
            <View style={styles.headerWeatherChip}>
              <Icon name="cloud" size={18} color={palette.textPrimary} />
              <Text style={styles.headerWeatherTemp}>{weather.temperature}°</Text>
            </View>
          )}
          <Pressable
            accessibilityLabel="Search"
            style={({ pressed }) => [
              styles.headerIconBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Icon name="search" size={22} color={palette.textPrimary} />
          </Pressable>
        </>
      )}
    </View>
  </View>
  );
};

// ============================================================================
// DAY TABS
// ============================================================================

interface DayTabsProps {
  tab: DayTab;
  setTab: (t: DayTab) => void;
}

const DayTabs: React.FC<DayTabsProps> = ({ tab, setTab }) => {
  const { locale } = useLanguage();
  const { styles } = useDesignStyles();
  const tabs: { k: DayTab; labelEn: string; labelEs: string }[] = [
    { k: 'yesterday', labelEn: 'Yesterday', labelEs: 'Ayer' },
    { k: 'today', labelEn: 'Today', labelEs: 'Hoy' },
    { k: 'tomorrow', labelEn: 'Tomorrow', labelEs: 'Mañana' },
  ];
  return (
    <View style={styles.tabs}>
      {tabs.map((t) => {
        const active = tab === t.k;
        return (
          <Pressable
            key={t.k}
            onPress={() => setTab(t.k)}
            style={[styles.tab, active && styles.tabActive]}
          >
            <Text
              style={[styles.tabLabel, active && styles.tabLabelActive]}
            >
              {locale === 'es' ? t.labelEs : t.labelEn}
            </Text>
            <Text
              style={[styles.tabSub, active && styles.tabSubActive]}
            >
              {getDayLabel(t.k)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

// ============================================================================
// ACTIVE LOAD CARD
// ============================================================================

interface ActiveLoadCardProps {
  load: any;
  onPress: () => void;
}

const ActiveLoadCard: React.FC<ActiveLoadCardProps> = ({ load, onPress }) => {
  const { palette, styles } = useDesignStyles();
  const pickupCity = load.firstPickup?.city;
  const pickupAddr = [load.firstPickup?.city, load.firstPickup?.state]
    .filter(Boolean)
    .join(', ');
  const dropoffCity = load.lastDelivery?.city;
  const dropoffAddr = [load.lastDelivery?.city, load.lastDelivery?.state]
    .filter(Boolean)
    .join(', ');
  const pickupTime = formatTime(load.firstPickup?.windowBeginDate);
  const dropoffTime = formatTime(load.lastDelivery?.windowBeginDate);

  const tags = loadFacetTags(load);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.activeCard,
        pressed && { opacity: 0.92 },
      ]}
    >
      <View style={styles.activeCardStripe} />

      <View style={styles.activeCardHeader}>
        <StatusChip status={load.trackingStatus || load.status} />
        <Icon name="chevron-right" size={18} color={palette.textTertiary} />
      </View>

      {tags.length > 0 && (
        <View style={styles.tagRow}>
          {tags.map((t) => (
            <Tag key={t} value={t} />
          ))}
        </View>
      )}

      <View style={styles.activeCardBody}>
        <RouteRail />
        <View style={{ flex: 1, minWidth: 0, gap: sp.cardGap }}>
          <StopRow
            kind="pickup"
            name={pickupCity ?? 'Pickup pending'}
            addr={pickupAddr}
            time={pickupTime}
            done
          />
          <StopRow
            kind="dropoff"
            name={dropoffCity ?? 'Delivery pending'}
            addr={dropoffAddr}
            time={dropoffTime}
            active
          />
        </View>
      </View>
    </Pressable>
  );
};

const RouteRail: React.FC = () => {
  const { palette, styles } = useDesignStyles();
  return (
    <View style={{ width: 18, position: 'relative' }}>
      <View style={styles.railLine} />
      <View style={[styles.railDot, { top: 4, backgroundColor: palette.bgSurface, borderColor: palette.success, borderWidth: 2 }]}>
        <View style={[StyleSheet.absoluteFillObject, { borderRadius: 99, margin: 2, backgroundColor: palette.success }]} />
      </View>
      <View style={[styles.railDot, {
        bottom: 4,
        backgroundColor: palette.accent,
        shadowColor: palette.accent,
        shadowOpacity: 0.4,
        shadowRadius: 4,
      }]} />
    </View>
  );
};

interface StopRowProps {
  kind: 'pickup' | 'dropoff';
  name: string;
  addr?: string;
  time: string | null;
  done?: boolean;
  active?: boolean;
}

const StopRow: React.FC<StopRowProps> = ({ kind, name, addr, time, done, active }) => {
  const { palette, styles } = useDesignStyles();
  return (
  <View style={{ minWidth: 0 }}>
    <Text style={styles.stopLabel}>
      {kind === 'pickup' ? 'PICKUP' : 'DROPOFF'}
      {done ? ' · DONE' : ''}
    </Text>
    <Text
      style={[
        styles.stopName,
        done && { color: palette.textSecondary, textDecorationLine: 'line-through' },
      ]}
      numberOfLines={1}
    >
      {name}
    </Text>
    <Text style={styles.stopAddr} numberOfLines={1}>
      {addr ?? '—'}
      {time && (
        <>
          {' · '}
          <Text
            style={{
              color: active ? palette.accent : palette.textTertiary,
              fontWeight: active ? '600' : '400',
            }}
          >
            {time}
          </Text>
        </>
      )}
    </Text>
  </View>
  );
};

// ============================================================================
// STATUS CHIP + TAG
// ============================================================================

const StatusChip: React.FC<{ status: string }> = ({ status }) => {
  const { palette, styles } = useDesignStyles();
  const s = status || 'Pending';
  const tone = statusTone(s, palette);
  return (
    <View style={[styles.statusChip, { backgroundColor: tone.bg }]}>
      <View style={[styles.statusDot, { backgroundColor: tone.fg }]} />
      <Text style={[styles.statusChipText, { color: tone.fg }]}>{s}</Text>
    </View>
  );
};

const statusTone = (status: string, palette: Palette): { bg: string; fg: string } => {
  if (status === 'In Transit' || status === 'In Progress')
    return { bg: 'rgba(46,92,255,0.16)', fg: palette.accent };
  if (status === 'Completed')
    return { bg: 'rgba(16,185,129,0.14)', fg: palette.success };
  if (status === 'At Pickup' || status === 'At Delivery')
    return { bg: 'rgba(124,58,237,0.14)', fg: '#A78BFA' };
  return { bg: 'rgba(255,255,255,0.06)', fg: palette.textSecondary };
};

const Tag: React.FC<{ value: string }> = ({ value }) => {
  const { styles } = useDesignStyles();
  const s = tagStyles[value] ?? tagFallback;
  return (
    <View style={[styles.tag, { backgroundColor: s.bg }]}>
      <Text style={[styles.tagText, { color: s.fg }]}>#{value}</Text>
    </View>
  );
};

// ============================================================================
// UPCOMING / COMPLETED SECTIONS
// ============================================================================

const UpcomingSection: React.FC<{
  loads: any[];
  isSessionMode: boolean;
  onPress: (loadId: string) => void;
}> = ({ loads, isSessionMode, onPress }) => {
  const { locale } = useLanguage();
  const { styles } = useDesignStyles();
  return (
    <View style={{ gap: sp.listGap }}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>
          {isSessionMode
            ? locale === 'es'
              ? `PRÓXIMAS · ${loads.length} CARGAS`
              : `UP NEXT · ${loads.length} LOADS`
            : locale === 'es'
              ? `PROGRAMADAS · ${loads.length}`
              : `SCHEDULED · ${loads.length}`}
        </Text>
      </View>
      {loads.map((load) => (
        <UpcomingRow key={load._id} load={load} onPress={() => onPress(load._id)} />
      ))}
    </View>
  );
};

const UpcomingRow: React.FC<{ load: any; onPress: () => void }> = ({ load, onPress }) => {
  const { palette, styles } = useDesignStyles();
  const pickup = load.firstPickup?.city ?? 'Pickup';
  const dropoff = load.lastDelivery?.city ?? 'Dropoff';
  const window = [
    formatTime(load.firstPickup?.windowBeginDate),
    formatTime(load.lastDelivery?.windowBeginDate),
  ]
    .filter(Boolean)
    .join(' – ');
  const tags = loadFacetTags(load);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.upcomingRow,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: sp.rowGap }}>
        <View style={styles.upcomingRoute}>
          <Text style={styles.upcomingCity} numberOfLines={1}>
            {pickup}
          </Text>
          <Icon name="arrow-right" size={14} color={palette.textTertiary} />
          <Text
            style={[styles.upcomingCity, { color: palette.textSecondary }]}
            numberOfLines={1}
          >
            {dropoff}
          </Text>
        </View>
        <Text style={styles.upcomingMeta} numberOfLines={1}>
          {window || 'Time TBD'}
          {typeof load.stopCount === 'number'
            ? ` · ${load.stopCount} stop${load.stopCount > 1 ? 's' : ''}`
            : ''}
        </Text>
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((v) => (
              <Tag key={v} value={v} />
            ))}
          </View>
        )}
      </View>
      <Icon name="chevron-right" size={18} color={palette.textTertiary} />
    </Pressable>
  );
};

const CompletedSection: React.FC<{ loads: any[]; isSessionMode: boolean }> = ({
  loads,
  isSessionMode,
}) => {
  const { locale } = useLanguage();
  const { palette, styles } = useDesignStyles();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: sp.listGap }}>
      <Pressable
        style={styles.completedFooter}
        onPress={() => setExpanded((v) => !v)}
      >
        <View style={styles.completedLeft}>
          <View style={styles.completedCheck}>
            <Icon name="check" size={14} color="#fff" strokeWidth={2.5} />
          </View>
          <Text style={styles.completedLabel}>
            {isSessionMode
              ? locale === 'es'
                ? 'Completadas en este turno'
                : 'Completed this shift'
              : locale === 'es'
                ? 'Completadas'
                : 'Completed'}
          </Text>
        </View>
        <View style={styles.completedRight}>
          <Text style={styles.completedCount}>{loads.length}</Text>
          <Icon
            name="chevron-down"
            size={18}
            color={palette.textTertiary}
          />
        </View>
      </Pressable>
      {expanded &&
        loads.map((load) => <UpcomingRow key={load._id} load={load} onPress={() => {}} />)}
    </View>
  );
};

// ============================================================================
// EMPTY STATE + BANNERS
// ============================================================================

type EmptyVariant = 'session' | 'today' | 'yesterday' | 'tomorrow';

interface EmptyCopy {
  icon: IconName;
  title: string;
  body: string;
  helper?: string;
  action?: string;
}

const getEmptyCopy = (variant: EmptyVariant, locale: string): EmptyCopy => {
  const isEs = locale === 'es';
  switch (variant) {
    case 'session':
      return {
        icon: 'package',
        title: isEs ? 'Nada en tu turno aún' : 'Nothing on your shift yet',
        body: isEs
          ? 'Los despachadores te asignarán cargas — aparecerán aquí.'
          : "Dispatch will assign loads here — you'll get a notification.",
      };
    case 'today':
      return {
        icon: 'truck',
        title: isEs ? 'Sin cargas hoy' : 'No loads today',
        body: isEs
          ? 'Todo despejado. Cuando despacho asigne cargas, aparecerán aquí.'
          : "You're all clear. Dispatch will push new loads here when they're assigned.",
        action: isEs ? 'Revisar de nuevo' : 'Check again',
      };
    case 'yesterday':
      return {
        icon: 'clock',
        title: isEs ? 'Nada entregado ayer' : 'Nothing delivered yesterday',
        body: isEs
          ? 'No tuviste cargas asignadas en tu último turno. El trabajo completado aparecerá aquí.'
          : "You didn't have any assigned loads on your last shift. Completed work will show here.",
      };
    case 'tomorrow':
      return {
        icon: 'calendar',
        title: isEs ? 'Nada programado aún' : 'Nothing scheduled yet',
        body: isEs
          ? 'Las cargas de mañana aparecerán aquí cuando despacho las finalice — normalmente antes de las 6 PM.'
          : "Tomorrow's loads will appear here once dispatch finalizes the board — usually by 6:00 PM the night before.",
        helper: isEs
          ? 'Te avisaremos cuando se asignen'
          : "We'll notify you when they're assigned",
      };
  }
};

const EmptyState: React.FC<{
  variant: EmptyVariant;
  locale: string;
  onRefresh: () => void;
  isRefreshing?: boolean;
}> = ({ variant, locale, onRefresh, isRefreshing }) => {
  const { palette, styles } = useDesignStyles();
  const copy = getEmptyCopy(variant, locale);
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIllustration}>
        <Icon name={copy.icon} size={40} color={palette.accent} strokeWidth={1.3} />
      </View>
      <Text style={styles.emptyTitle}>{copy.title}</Text>
      <Text style={styles.emptyBody}>{copy.body}</Text>
      {copy.helper && (
        <View style={styles.emptyHelper}>
          <View style={[styles.emptyHelperDot, { backgroundColor: palette.success }]} />
          <Text style={styles.emptyHelperText}>{copy.helper}</Text>
        </View>
      )}
      {copy.action && (
        <Pressable
          onPress={onRefresh}
          disabled={isRefreshing}
          style={({ pressed }) => [
            styles.emptyCta,
            pressed && { opacity: 0.85 },
            isRefreshing && { opacity: 0.6 },
          ]}
        >
          <Icon name="refresh" size={14} color={palette.textSecondary} />
          <Text style={styles.emptyCtaText}>{copy.action}</Text>
        </Pressable>
      )}
    </View>
  );
};

const SoftCapBanner: React.FC<{ level: '10h' | '14h'; locale: string }> = ({
  level,
  locale,
}) => {
  const { palette, styles } = useDesignStyles();
  const isCritical = level === '14h';
  const bg = isCritical ? 'rgba(239,68,68,0.14)' : 'rgba(245,158,11,0.14)';
  const fg = isCritical ? palette.danger : palette.warning;
  const title =
    level === '14h'
      ? locale === 'es'
        ? 'Más de 14 horas en turno'
        : '14+ hours on shift'
      : locale === 'es'
        ? 'Más de 10 horas en turno'
        : '10+ hours on shift';
  const body =
    level === '14h'
      ? locale === 'es'
        ? 'Considera terminar tu turno y descansar.'
        : 'Consider ending your shift and resting.'
      : locale === 'es'
        ? 'Has estado trabajando 10 horas.'
        : "You've been on shift 10 hours.";
  return (
    <View style={[styles.softCapBanner, { backgroundColor: bg }]}>
      <Icon name={isCritical ? 'warning' : 'info'} size={18} color={fg} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.softCapTitle, { color: fg }]}>{title}</Text>
        <Text style={styles.softCapBody}>{body}</Text>
      </View>
    </View>
  );
};

const ConnectionBanner: React.FC<{
  label: string;
  pending: number;
  pendingLabel: string;
  tone: 'danger' | 'warning';
}> = ({ label, pending, pendingLabel, tone }) => {
  const { palette, styles } = useDesignStyles();
  return (
  <View
    style={[
      styles.connBanner,
      {
        backgroundColor:
          tone === 'danger'
            ? 'rgba(239,68,68,0.16)'
            : 'rgba(245,158,11,0.16)',
      },
    ]}
  >
    <Text
      style={[
        styles.connBannerText,
        {
          color: tone === 'danger' ? palette.danger : palette.warning,
        },
      ]}
    >
      {label}
      {pending > 0 ? ` · ${pending} ${pendingLabel}` : ''}
    </Text>
  </View>
  );
};

const LoadingSkeleton: React.FC = () => {
  const { styles } = useDesignStyles();
  return (
  <View style={{ gap: sp.sectionGap, paddingTop: spacing.s2 }}>
    <View style={[styles.skeleton, { height: 220 }]} />
    <View style={[styles.skeleton, { height: 90 }]} />
    <View style={[styles.skeleton, { height: 90 }]} />
  </View>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.bgCanvas,
  },
  scroll: {
    paddingHorizontal: sp.screenPx,
    paddingVertical: sp.screenPy,
    paddingBottom: 120,
    gap: sp.sectionGap,
  },

  // Header
  header: {
    paddingHorizontal: sp.screenPx,
    paddingTop: sp.headerPy,
    paddingBottom: sp.headerPy,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: palette.bgCanvas, // per design-principles: header sits on canvas, no fill, no border
  },
  headerGreeting: {
    fontSize: 11,
    lineHeight: 14,
    color: palette.textTertiary,
    fontWeight: '500',
  },
  headerTitle: {
    ...typeScale.headingSm,
    color: palette.textPrimary,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerIconBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerWeatherChip: {
    height: 44,
    paddingHorizontal: 10,
    borderRadius: radii.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerWeatherTemp: {
    fontSize: 13,
    fontWeight: '600',
    color: palette.textPrimary,
  },
  endShiftPill: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radii.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: palette.danger,
  },
  endShiftPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },

  // Tabs
  tabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: sp.screenPx,
    paddingTop: 4,
    paddingBottom: sp.headerPy,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    paddingVertical: sp.tabPy,
    paddingHorizontal: 8,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabActive: {
    backgroundColor: palette.accentTint,
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: palette.textSecondary,
  },
  tabLabelActive: {
    color: palette.accent,
    fontWeight: '600',
  },
  tabSub: {
    fontSize: 11,
    color: palette.textTertiary,
  },
  tabSubActive: {
    color: palette.accent,
    opacity: 0.8,
  },

  // Active card
  activeCard: {
    backgroundColor: palette.bgSurface,
    borderRadius: radii.lg,
    padding: sp.cardPadding,
    paddingLeft: sp.cardPadding + 2,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    gap: sp.cardGap,
    position: 'relative',
    overflow: 'hidden',
  },
  activeCardStripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: palette.accent,
  },
  activeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  activeCardBody: {
    flexDirection: 'row',
    gap: 12,
  },
  railLine: {
    position: 'absolute',
    left: 8,
    top: 10,
    bottom: 10,
    width: 2,
    backgroundColor: palette.borderDefault,
  },
  railDot: {
    position: 'absolute',
    left: 3,
    width: 12,
    height: 12,
    borderRadius: 99,
  },

  // Stop row
  stopLabel: {
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
    color: palette.textTertiary,
    letterSpacing: 1,
  },
  stopName: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    color: palette.textPrimary,
  },
  stopAddr: {
    fontSize: 11,
    lineHeight: 14,
    color: palette.textTertiary,
  },

  // Status + tags
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.full,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusChipText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tagRow: {
    flexDirection: 'row',
    gap: 4,
    flexWrap: 'wrap',
  },
  tag: {
    height: 20,
    paddingHorizontal: 7,
    borderRadius: radii.xs,
    justifyContent: 'center',
  },
  tagText: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },

  // Sections
  sectionHead: {
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: palette.textTertiary,
  },

  // Upcoming row
  upcomingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: sp.listPx,
    borderRadius: radii.lg,
    backgroundColor: palette.bgSurface,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
  },
  upcomingRoute: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  upcomingCity: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    color: palette.textPrimary,
    flexShrink: 1,
  },
  upcomingMeta: {
    fontSize: 11,
    lineHeight: 14,
    color: palette.textTertiary,
  },

  // Completed footer
  completedFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: sp.listPx,
    borderRadius: radii.lg,
    backgroundColor: palette.bgMuted,
  },
  completedLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  completedCheck: {
    width: 24,
    height: 24,
    borderRadius: 99,
    backgroundColor: palette.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completedLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: palette.textSecondary,
  },
  completedRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  completedCount: {
    fontSize: 14,
    fontWeight: '600',
    color: palette.textTertiary,
  },

  // Empty state
  emptyWrap: {
    alignItems: 'center',
    paddingTop: 48,
    paddingBottom: 32,
    paddingHorizontal: sp.screenPx,
  },
  emptyIllustration: {
    width: 88,
    height: 88,
    borderRadius: 999,
    backgroundColor: palette.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...typeScale.headingSm,
    color: palette.textPrimary,
    textAlign: 'center',
    marginTop: 24,
    marginBottom: 6,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: palette.textSecondary,
    textAlign: 'center',
    maxWidth: 280,
  },
  emptyHelper: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emptyHelperDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  emptyHelperText: {
    fontSize: 12,
    color: palette.textTertiary,
  },
  emptyCta: {
    marginTop: 16,
    height: comp.btnMd.height,
    paddingHorizontal: comp.btnMd.paddingHorizontal,
    borderRadius: comp.btnMd.radius,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: palette.borderDefault,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emptyCtaText: {
    color: palette.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },

  // Banners
  connBanner: {
    paddingHorizontal: sp.screenPx,
    paddingVertical: 8,
    alignItems: 'center',
  },
  connBannerText: {
    fontSize: 12,
    fontWeight: '600',
  },
  softCapBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: radii.lg,
  },
  softCapTitle: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  softCapBody: {
    fontSize: 12,
    lineHeight: 16,
    color: palette.textSecondary,
    marginTop: 2,
  },

  // Skeleton
  skeleton: {
    backgroundColor: palette.bgMuted,
    borderRadius: radii.lg,
  },
});
