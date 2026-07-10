import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Pressable,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useMyLoads } from '../../../lib/hooks/useMyLoads';
import { useDriver } from '../_layout';
import { useLanguage } from '../../../lib/LanguageContext';
import { trackScreen } from '../../../lib/analytics';
import { Icon, type IconName } from '../../../lib/design-icons';
import {
  typeScale,
  densitySpacing,
  densityComponents,
  radii,
  spacing,
  type Palette,
} from '../../../lib/design-tokens';
import { useTheme } from '../../../lib/ThemeContext';
import {
  loadFacetTags,
  tagKindStyles,
  type FacetTag,
} from '../../../lib/facet-tags';

// ============================================================================
// DRIVER DASHBOARD — Otoqa Driver design
//
// Always calendar mode (Yesterday / Today / Tomorrow tabs). Shift start/end
// lives on the More tab.
//
// Today tab pins the active load at the top regardless of its own planned
// date — covers multi-day trips that started yesterday but are still in
// progress. Below the active load: today's Completed, then today's
// Scheduled sorted by dispatchLeg.plannedStartAt (or windowBeginDate as
// a fallback). Yesterday and Tomorrow tabs ignore the active-load pin
// and just show that day's planned + completed list.
// ============================================================================

/**
 * Tiny wrapper so sub-components inside this file get `palette`, density-
 * resolved `sp` / `comp`, and memoized `styles` without each duplicating
 * the hook-plus-useMemo boilerplate. Density defaults to `'dense'` but
 * flips live the moment the driver changes it in App Settings.
 */
function useDesignStyles() {
  const { palette, density } = useTheme();
  const sp = densitySpacing[density];
  const comp = densityComponents[density];
  const styles = useMemo(
    () => makeStyles(palette, sp, comp),
    [palette, sp, comp],
  );
  return { palette, styles, sp, comp };
}

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

// loadFacetTags / tagKindStyles / FacetTag / equipmentShortCode now live
// in mobile/lib/facet-tags.ts so trip detail + future surfaces share them.

// Time-of-day greeting per design
const greet = (): string => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

// On-duty pill — green vocabulary mirrors the More-tab ShiftCard.
const ON_DUTY_GREEN = '#10B981';

function formatElapsed(startedAtMs?: number): string {
  if (!startedAtMs) return '0h 00m';
  const diffMs = Date.now() - startedAtMs;
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${hours}h ${mins.toString().padStart(2, '0')}m`;
}

// ============================================================================
// SCREEN
// ============================================================================

export default function HomeScreen() {
  const router = useRouter();
  const { palette, styles } = useDesignStyles();
  const { driverId, driverName } = useDriver();
  const firstName = driverName.trim().split(/\s+/)[0] || 'Driver';
  // Home is always calendar mode. Shift start/end lives on the More tab,
  // so this screen never needs to branch on session status. An active
  // load is detected from the load's own status fields below.
  const { loads, isLoading, refetch, isRefetching } = useMyLoads(driverId);
  const { locale } = useLanguage();

  const [selectedDay, setSelectedDay] = useState<DayTab>('today');

  // Active shift — drives the always-visible "On duty" pill in the header.
  // Tapping it routes to the More tab where the End-shift control lives.
  const activeSession = useQuery(
    api.driverSessions.getActiveSession,
    driverId ? { driverId } : 'skip',
  );

  useEffect(() => {
    trackScreen('Home');
  }, []);

  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const selectedDateStr = useMemo(() => getDateStringForDay(selectedDay), [selectedDay]);

  // Bucket loads for the currently-selected day tab.
  //
  //   Today: active load pinned at the top regardless of its own planned
  //     date (covers multi-day trips that started yesterday but are still
  //     in progress), then today's Completed, then today's Scheduled
  //     sorted by plannedStartAt (with firstPickup.windowBeginDate as a
  //     secondary key for loads that don't have a dispatchLeg assigned
  //     yet).
  //
  //   Yesterday / Tomorrow: no active pin. Just the day's Scheduled +
  //     Completed, same sort rules. The active load, if any, stays on
  //     Today until it's completed — then it falls into its own day's
  //     Completed section.
  const { activeLoad, scheduledLoads, completedLoads } = useMemo(() => {
    if (!loads || loads.length === 0) {
      return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
    }

    const isCompleted = (l: any) =>
      l.status === 'Completed' || l.trackingStatus === 'Completed';
    const isInProgress = (l: any) =>
      !isCompleted(l) &&
      (l.trackingStatus === 'In Transit' ||
        l.trackingStatus === 'At Pickup' ||
        l.trackingStatus === 'At Delivery' ||
        l.status === 'In Progress');

    const inProgress = loads.find(isInProgress) ?? null;

    const sortByStart = (a: any, b: any) => {
      // plannedStartAt is already an epoch-ms number. Fallback is the
      // pickup's ISO timestamp (windowBeginTime) — NOT windowBeginDate,
      // which is date-only and parses as UTC midnight for every row.
      const aKey =
        typeof a.legPlannedStartAt === 'number'
          ? a.legPlannedStartAt
          : Date.parse(a.firstPickup?.windowBeginTime ?? '') || Number.POSITIVE_INFINITY;
      const bKey =
        typeof b.legPlannedStartAt === 'number'
          ? b.legPlannedStartAt
          : Date.parse(b.firstPickup?.windowBeginTime ?? '') || Number.POSITIVE_INFINITY;
      return aKey - bKey;
    };

    const forDay = loads.filter((l) => getLoadPickupDate(l) === selectedDateStr);

    const scheduled = forDay
      .filter((l) => !isCompleted(l) && l._id !== inProgress?._id)
      .sort(sortByStart);
    const completed = forDay.filter(isCompleted).sort(sortByStart);

    const activeForTab = selectedDay === 'today' ? inProgress : null;

    return {
      activeLoad: activeForTab,
      scheduledLoads: scheduled,
      completedLoads: completed,
    };
  }, [loads, selectedDateStr, selectedDay]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Connection state (offline AND weak signal) is surfaced globally by
          the OfflineIndicator pill — see (app)/_layout.tsx. */}
      <TopHeader
        greeting={greet()}
        driverFirstName={firstName}
        onDuty={!!activeSession}
        startedAt={activeSession?.startedAt}
        onPressShift={() => router.push('/(app)/(driver-tabs)/more')}
      />

      <DayTabs tab={selectedDay} setTab={setSelectedDay} />

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
            onPress={(id) => router.push(`/trip/${id}`)}
          />
        )}

        {!isLoading && completedLoads.length > 0 && (
          <CompletedSection loads={completedLoads} />
        )}

        {!isLoading &&
          !activeLoad &&
          scheduledLoads.length === 0 &&
          completedLoads.length === 0 && (
            <EmptyState
              variant={selectedDay}
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
  onDuty: boolean;
  startedAt?: number;
  onPressShift: () => void;
}

const TopHeader: React.FC<TopHeaderProps> = ({
  greeting,
  driverFirstName,
  onDuty,
  startedAt,
  onPressShift,
}) => {
  const { styles } = useDesignStyles();
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.headerGreeting}>{greeting}</Text>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {driverFirstName}
        </Text>
      </View>

      {onDuty && <OnDutyPill startedAt={startedAt} onPress={onPressShift} />}
    </View>
  );
};

// Always-visible "On duty" status chip — a passive reminder to clock out
// (forgetting is the #1 driver mistake). Mirrors the green-dot + pulse
// vocabulary of the More-tab ShiftCard; tapping routes there to end the
// shift. Elapsed re-renders each minute while this screen is mounted.
const OnDutyPill: React.FC<{ startedAt?: number; onPress: () => void }> = ({
  startedAt,
  onPress,
}) => {
  const { palette, styles } = useDesignStyles();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const ringScale = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.9, 2.2, 2.2] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.8, 0, 0] });

  const elapsed = formatElapsed(startedAt);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`On duty, ${elapsed} elapsed. Tap to open your shift.`}
      style={({ pressed }) => [styles.onDutyPill, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.onDutyDotWrap}>
        <Animated.View
          style={[styles.onDutyDotRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]}
        />
        <View style={styles.onDutyDot} />
      </View>
      <Text style={styles.onDutyLabel}>On duty</Text>
      <View style={styles.onDutyDivider} />
      <Text style={styles.onDutyElapsed}>{elapsed}</Text>
      <Icon name="chevron-right" size={14} color={palette.textTertiary} />
    </Pressable>
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
  const { palette, styles, sp } = useDesignStyles();
  const pickupCity = load.firstPickup?.city;
  const pickupAddr = [load.firstPickup?.city, load.firstPickup?.state]
    .filter(Boolean)
    .join(', ');
  const dropoffCity = load.lastDelivery?.city;
  const dropoffAddr = [load.lastDelivery?.city, load.lastDelivery?.state]
    .filter(Boolean)
    .join(', ');
  // windowBeginDate / windowEndDate are calendar dates only ("2026-04-20")
  // — parsing them yields UTC midnight which lands at 5pm Pacific. Use the
  // full ISO timestamps instead so local time renders correctly.
  const pickupTime = formatTime(load.firstPickup?.windowBeginTime);
  const dropoffTime = formatTime(load.lastDelivery?.windowEndTime);

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
            <Tag key={t.label} tag={t} />
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

const Tag: React.FC<{ tag: FacetTag }> = ({ tag }) => {
  const { palette, styles } = useDesignStyles();
  const s = tagKindStyles(tag.kind, tag.label, palette);
  return (
    <View style={[styles.tag, { backgroundColor: s.bg }]}>
      <Text style={[styles.tagText, { color: s.fg }]}>{tag.label}</Text>
    </View>
  );
};

// ============================================================================
// UPCOMING / COMPLETED SECTIONS
// ============================================================================

const UpcomingSection: React.FC<{
  loads: any[];
  onPress: (loadId: string) => void;
}> = ({ loads, onPress }) => {
  const { locale } = useLanguage();
  const { styles, sp } = useDesignStyles();
  return (
    <View style={{ gap: sp.listGap }}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>
          {locale === 'es' ? `PROGRAMADAS · ${loads.length}` : `SCHEDULED · ${loads.length}`}
        </Text>
      </View>
      {loads.map((load) => (
        <UpcomingRow key={load._id} load={load} onPress={() => onPress(load._id)} />
      ))}
    </View>
  );
};

const UpcomingRow: React.FC<{ load: any; onPress: () => void }> = ({ load, onPress }) => {
  const { palette, styles, sp } = useDesignStyles();
  const pickup = load.firstPickup?.city ?? 'Pickup';
  const dropoff = load.lastDelivery?.city ?? 'Dropoff';
  // Use the full ISO timestamps — windowBeginDate/windowEndDate are date-only
  // strings that parse to UTC midnight and always render as 5pm in Pacific.
  const window = [
    formatTime(load.firstPickup?.windowBeginTime),
    formatTime(load.lastDelivery?.windowEndTime),
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
            {tags.map((t) => (
              <Tag key={t.label} tag={t} />
            ))}
          </View>
        )}
      </View>
      <Icon name="chevron-right" size={18} color={palette.textTertiary} />
    </Pressable>
  );
};

const CompletedSection: React.FC<{ loads: any[] }> = ({ loads }) => {
  const { locale } = useLanguage();
  const { palette, styles, sp } = useDesignStyles();
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
            {locale === 'es' ? 'Completadas' : 'Completed'}
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

type EmptyVariant = 'today' | 'yesterday' | 'tomorrow';

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

const LoadingSkeleton: React.FC = () => {
  const { styles, sp } = useDesignStyles();
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

const makeStyles = (
  palette: Palette,
  sp: (typeof densitySpacing)['dense'],
  comp: (typeof densityComponents)['dense'],
) =>
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
  onDutyPill: {
    height: 28,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: radii.full,
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.28)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  onDutyDotWrap: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onDutyDotRing: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 99,
    borderWidth: 2,
    borderColor: ON_DUTY_GREEN,
  },
  onDutyDot: {
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: ON_DUTY_GREEN,
  },
  onDutyLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: ON_DUTY_GREEN,
  },
  onDutyDivider: {
    width: 1,
    height: 12,
    backgroundColor: 'rgba(16,185,129,0.3)',
  },
  onDutyElapsed: {
    fontSize: 12,
    fontWeight: '600',
    color: palette.textSecondary,
    fontVariant: ['tabular-nums'],
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
