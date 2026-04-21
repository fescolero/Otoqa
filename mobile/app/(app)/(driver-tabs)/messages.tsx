/**
 * Messages — Otoqa Driver design system (port of lib/messages-screen.jsx).
 *
 * This is a notifications inbox, not a chat. Every row is informational
 * — compliance flags, route delays, payroll posts, system updates — and
 * tapping a row with a deeplink opens the relevant screen later (stub
 * for now).
 *
 * Grouped by day bucket (Today / Yesterday / Earlier this week). Filter
 * chips across the top (All / Unread / Alerts / Updates). Unread rows
 * get a subtle accent tint and a dot next to the title. A "Mark all
 * read" action sits top-right when unread > 0.
 *
 * No real backend yet — `threads` is [] until we wire a query. The
 * Empty state has four filter-specific variants mirroring the design.
 */
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { Icon, type IconName } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

type MessageKind = 'route' | 'compliance' | 'payroll' | 'system';
type DayKey = 'today' | 'yest' | 'earlier';
type Filter = 'all' | 'unread' | 'alerts' | 'updates';

interface Message {
  id: string;
  kind: MessageKind;
  day: DayKey;
  time: string;
  title: string;
  body: string;
  deeplink?: string;
  unread: boolean;
}

// No real backend — empty array surfaces the empty state. When a
// `getMessages` query lands, swap to `useQuery(...)` and keep the local
// `readIds` state for optimistic mark-as-read.
const INITIAL: Message[] = [];

const DAY_ORDER: DayKey[] = ['today', 'yest', 'earlier'];
const DAY_LABEL: Record<DayKey, string> = {
  today: 'Today',
  yest: 'Yesterday',
  earlier: 'Earlier this week',
};

const KIND_META: Record<
  MessageKind,
  { icon: IconName; tint: string; color: (p: Palette) => string }
> = {
  route: {
    icon: 'navigate',
    tint: 'rgba(245, 158, 11, 0.14)',
    color: (p) => p.warning,
  },
  compliance: {
    icon: 'shield',
    tint: 'rgba(245, 158, 11, 0.14)',
    color: (p) => p.warning,
  },
  payroll: {
    icon: 'dollar',
    tint: 'rgba(16, 185, 129, 0.14)',
    color: (p) => p.success,
  },
  system: {
    icon: 'info',
    tint: 'rgba(107, 115, 133, 0.18)',
    color: (p) => p.textSecondary,
  },
};

export default function MessagesScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const [messages] = useState<Message[]>(INITIAL);
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(INITIAL.filter((m) => !m.unread).map((m) => m.id)),
  );
  const [filter, setFilter] = useState<Filter>('all');

  const unreadCount = useMemo(
    () => messages.filter((m) => !readIds.has(m.id)).length,
    [messages, readIds],
  );

  const markRead = (id: string) =>
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const markAllRead = () =>
    setReadIds(new Set(messages.map((m) => m.id)));

  const visible = useMemo(() => {
    if (filter === 'unread') return messages.filter((m) => !readIds.has(m.id));
    if (filter === 'alerts')
      return messages.filter((m) => m.kind === 'compliance' || m.kind === 'route');
    if (filter === 'updates')
      return messages.filter((m) => m.kind === 'system' || m.kind === 'payroll');
    return messages;
  }, [messages, readIds, filter]);

  const grouped = useMemo(
    () =>
      DAY_ORDER.map((key) => ({
        key,
        items: visible.filter((m) => m.day === key),
      })).filter((g) => g.items.length > 0),
    [visible],
  );

  const openRow = (m: Message) => {
    markRead(m.id);
    // Deeplink routing — these screens exist today and can absorb the tap.
    // Unknown deeplinks fall through to the dashboard.
    if (m.deeplink === 'permissions') router.push('/permissions');
    else if (m.deeplink === 'compliance')
      router.push('/(driver-tabs)/settings');
    else if (m.deeplink === 'payroll')
      router.push('/(driver-tabs)/settings');
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <View style={styles.topTitleRow}>
          <Text style={styles.topTitle}>Messages</Text>
          {unreadCount > 0 && (
            <Text style={styles.unreadCountText}>{unreadCount}</Text>
          )}
        </View>
        <Pressable
          onPress={markAllRead}
          disabled={unreadCount === 0}
          accessibilityLabel="Mark all as read"
          style={({ pressed }) => [
            styles.markAllBtn,
            pressed && unreadCount > 0 && { opacity: 0.7 },
            unreadCount === 0 && { opacity: 0.4 },
          ]}
        >
          <Text
            style={[
              styles.markAllText,
              unreadCount === 0
                ? { color: palette.textTertiary }
                : { color: palette.accent },
            ]}
          >
            Mark all read
          </Text>
        </Pressable>
      </View>

      <FilterChips
        palette={palette}
        filter={filter}
        setFilter={setFilter}
        unreadCount={unreadCount}
      />

      {grouped.length === 0 ? (
        // Empty state skips the ScrollView so its wrapper can flex-1
        // and vertically center the illustration + copy in the remaining
        // space below the filter chips.
        <EmptyState palette={palette} filter={filter} />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {grouped.map((g, gi) => (
            <View key={g.key} style={{ marginTop: gi === 0 ? 6 : 20 }}>
              <Text style={styles.dayHeader}>{DAY_LABEL[g.key]}</Text>
              <View style={styles.groupCard}>
                {g.items.map((m, i) => (
                  <MessageRow
                    key={m.id}
                    palette={palette}
                    msg={m}
                    isRead={readIds.has(m.id)}
                    isFirst={i === 0}
                    onPress={() => openRow(m)}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ============================================================================
// FILTER CHIPS
// ============================================================================

const FilterChips: React.FC<{
  palette: Palette;
  filter: Filter;
  setFilter: (f: Filter) => void;
  unreadCount: number;
}> = ({ palette, filter, setFilter, unreadCount }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const chips: Array<{ k: Filter; label: string }> = [
    { k: 'all', label: 'All' },
    {
      k: 'unread',
      label: unreadCount > 0 ? `Unread · ${unreadCount}` : 'Unread',
    },
    { k: 'alerts', label: 'Alerts' },
    { k: 'updates', label: 'Updates' },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.filterScroll}
      contentContainerStyle={styles.chipRow}
    >
      {chips.map((c) => {
        const active = filter === c.k;
        return (
          <Pressable
            key={c.k}
            onPress={() => setFilter(c.k)}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                active && styles.chipTextActive,
              ]}
            >
              {c.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
};

// ============================================================================
// MESSAGE ROW
// ============================================================================

const MessageRow: React.FC<{
  palette: Palette;
  msg: Message;
  isRead: boolean;
  isFirst: boolean;
  onPress: () => void;
}> = ({ palette, msg, isRead, isFirst, onPress }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const meta = KIND_META[msg.kind];
  const hasLink = !!msg.deeplink;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.msgRow,
        !isFirst && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: palette.borderSubtle,
        },
        !isRead && { backgroundColor: palette.accentTint },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[styles.msgIcon, { backgroundColor: meta.tint }]}>
        <Icon name={meta.icon} size={20} color={meta.color(palette)} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.msgTitleRow}>
          {!isRead && <View style={styles.unreadDot} />}
          <Text
            style={[
              styles.msgTitle,
              !isRead && { color: palette.textPrimary, fontWeight: '700' },
            ]}
            numberOfLines={1}
          >
            {msg.title}
          </Text>
        </View>
        <Text style={styles.msgBody} numberOfLines={2}>
          {msg.body}
        </Text>
      </View>
      <View style={styles.msgTrailing}>
        <Text style={styles.msgTime}>{msg.time}</Text>
        {hasLink && (
          <Icon name="chevron-right" size={16} color={palette.textTertiary} />
        )}
      </View>
    </Pressable>
  );
};

// ============================================================================
// EMPTY STATE — four filter-specific variants
// ============================================================================

const EMPTY_COPY: Record<
  Filter,
  { kind: EmptyKind; title: string; body: string; helper?: string }
> = {
  all: {
    kind: 'inbox',
    title: 'All caught up',
    body:
      "You haven't missed anything. New alerts and updates will land here.",
    helper: "We'll ping you when something needs attention",
  },
  unread: {
    kind: 'check',
    title: 'Nothing unread',
    body: "You've seen everything. Come back after your next stop.",
  },
  alerts: {
    kind: 'shield',
    title: 'No alerts right now',
    body:
      'Route changes, delays, and compliance reminders will show up here.',
    helper: 'Everything looks good',
  },
  updates: {
    kind: 'dollar',
    title: 'No recent updates',
    body:
      'Payroll, direct deposits, and app updates will appear here.',
  },
};

type EmptyKind = 'inbox' | 'check' | 'shield' | 'dollar';

const EmptyState: React.FC<{ palette: Palette; filter: Filter }> = ({
  palette,
  filter,
}) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const copy = EMPTY_COPY[filter];
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIllustration}>
        <EmptyIllustration kind={copy.kind} color={palette.accent} />
      </View>
      <Text style={styles.emptyTitle}>{copy.title}</Text>
      <Text style={styles.emptyBody}>{copy.body}</Text>
      {copy.helper && (
        <View style={styles.emptyHelper}>
          <View style={[styles.emptyHelperDot, { backgroundColor: palette.success }]} />
          <Text style={styles.emptyHelperText}>{copy.helper}</Text>
        </View>
      )}
    </View>
  );
};

// Filter-specific line-art SVGs matching lib/messages-screen.jsx's
// InboxIllustration. HugeIcons don't match these closely enough — the
// inbox variant in particular has a custom notification-dot composition
// that the stock icon can't represent.
const EmptyIllustration: React.FC<{ kind: EmptyKind; color: string }> = ({
  kind,
  color,
}) => {
  const common = {
    stroke: color,
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };
  return (
    <Svg width={44} height={44} viewBox="0 0 24 24">
      {kind === 'inbox' && (
        <>
          <Path d="M4 13l2-7h12l2 7" {...common} />
          <Path d="M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5" {...common} />
          <Path d="M4 13h4l1.5 2h5L16 13h4" {...common} />
          <Circle cx="18" cy="6" r="2.2" fill={color} opacity={0.25} />
        </>
      )}
      {kind === 'check' && (
        <>
          <Circle cx="12" cy="12" r="8" {...common} />
          <Path d="M8.5 12.3l2.4 2.4 4.6-5.4" {...common} />
          <Path
            d="M5 6l1.5 1.5M19 6l-1.5 1.5M5 18l1.5-1.5M19 18l-1.5-1.5"
            {...common}
            opacity={0.35}
          />
        </>
      )}
      {kind === 'shield' && (
        <>
          <Path
            d="M12 4l7 2.5V12c0 3.9-2.9 7-7 8-4.1-1-7-4.1-7-8V6.5L12 4z"
            {...common}
          />
          <Path d="M9 12.3l2.2 2.2L15 10.5" {...common} />
        </>
      )}
      {kind === 'dollar' && (
        <>
          <Circle cx="12" cy="12" r="8" {...common} />
          <Path d="M12 7v10" {...common} />
          <Path
            d="M15 9.3a2.7 2.7 0 00-2.7-1.8H11a2.3 2.3 0 000 4.6h2a2.3 2.3 0 010 4.6h-1.4a2.7 2.7 0 01-2.7-1.8"
            {...common}
          />
        </>
      )}
    </Svg>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },

    topBar: {
      paddingHorizontal: sp.screenPx,
      paddingTop: 4,
      paddingBottom: sp.headerPy,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topTitleRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 8,
    },
    topTitle: {
      ...typeScale.headingLg,
      color: palette.textPrimary,
    },
    unreadCountText: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textTertiary,
      fontVariant: ['tabular-nums'],
    },
    markAllBtn: {
      height: 32,
      paddingHorizontal: 10,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    markAllText: {
      fontSize: 13,
      fontWeight: '600',
    },

    // flexGrow: 0 so this horizontal scroll row only takes the height
    // it actually needs (≈ chip height + bottom padding). Without it the
    // ScrollView stretches to fill the column parent, which was shoving
    // the empty state below the vertical center of the available area.
    filterScroll: {
      flexGrow: 0,
    },
    chipRow: {
      paddingHorizontal: sp.screenPx,
      paddingBottom: 10,
      gap: 6,
      alignItems: 'center',
    },
    chip: {
      height: 30,
      paddingHorizontal: 12,
      borderRadius: radii.full,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipActive: {
      borderColor: palette.accent,
      backgroundColor: palette.accentTint,
    },
    chipText: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textSecondary,
    },
    chipTextActive: {
      color: palette.accent,
    },

    dayHeader: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      color: palette.textTertiary,
      textTransform: 'uppercase',
      paddingHorizontal: sp.screenPx,
      paddingBottom: 6,
    },
    groupCard: {
      marginHorizontal: sp.screenPx,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      borderRadius: radii.lg,
      overflow: 'hidden',
    },

    msgRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: sp.listPx,
      paddingVertical: sp.listPy,
    },
    msgIcon: {
      width: 40,
      height: 40,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    msgTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    unreadDot: {
      width: 6,
      height: 6,
      borderRadius: 999,
      backgroundColor: palette.accent,
    },
    msgTitle: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    msgBody: {
      fontSize: 12,
      color: palette.textTertiary,
      marginTop: 2,
      lineHeight: 16,
    },
    msgTrailing: {
      alignItems: 'flex-end',
      gap: 4,
      flexShrink: 0,
    },
    msgTime: {
      fontSize: 11,
      color: palette.textTertiary,
      fontVariant: ['tabular-nums'],
    },

    // Fills the space below the filter chips + vertically centers its
    // contents. Filter ScrollView is now flexGrow: 0 so the remaining
    // vertical area is unambiguous, no bias padding needed.
    emptyWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
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
  });
