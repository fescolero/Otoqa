/**
 * Messages — Otoqa Driver design system.
 *
 * Two surfaces:
 *   - List: ordered by most-recent activity. Each row is avatar + name
 *     + preview + timestamp, with a dot when unread. Tapping routes to
 *     the thread.
 *   - Empty state: same circular-illustration + title + body pattern
 *     the dashboard uses, so drivers see one consistent "nothing here"
 *     vocabulary.
 *
 * No backend yet — the list reads from a local `threads` array, which
 * is [] until we plumb in a real query. The toggle is a one-liner once
 * that ships.
 */
import React, { useMemo } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import { useLanguage } from '../../../lib/LanguageContext';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

// Thread shape — loosely matches what a future `api.messages.getThreads`
// would surface. Kept thin until backend defines the real wire format.
interface Thread {
  id: string;
  name: string;
  preview: string;
  timestamp: string;
  initials: string;
  unread: boolean;
}

// TEMP: empty until we wire a threads query. Swap to `useQuery(...)`
// once the backend ships.
const threads: Thread[] = [];

export default function MessagesScreen() {
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const { locale } = useLanguage();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Text style={styles.topBarTitle}>Messages</Text>
        <Pressable
          accessibilityLabel="Search messages"
          style={({ pressed }) => [styles.topBarBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="search" size={22} color={palette.textPrimary} />
        </Pressable>
      </View>

      {threads.length === 0 ? (
        <EmptyState palette={palette} locale={locale} />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {threads.map((t) => (
            <ThreadRow
              key={t.id}
              palette={palette}
              thread={t}
              onPress={() =>
                Alert.alert(t.name, 'Thread view is coming soon.')
              }
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const ThreadRow: React.FC<{
  palette: Palette;
  thread: Thread;
  onPress: () => void;
}> = ({ palette, thread, onPress }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{thread.initials}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rowHeader}>
          <Text
            style={[styles.name, thread.unread && { fontWeight: '700' }]}
            numberOfLines={1}
          >
            {thread.name}
          </Text>
          <Text style={styles.timestamp}>{thread.timestamp}</Text>
        </View>
        <View style={styles.previewRow}>
          <Text
            style={[
              styles.preview,
              thread.unread && { color: palette.textPrimary, fontWeight: '500' },
            ]}
            numberOfLines={1}
          >
            {thread.preview}
          </Text>
          {thread.unread && <View style={styles.unreadDot} />}
        </View>
      </View>
    </Pressable>
  );
};

const EmptyState: React.FC<{ palette: Palette; locale: string }> = ({
  palette,
  locale,
}) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  const isEs = locale === 'es';
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIllustration}>
        <Icon name="message" size={40} color={palette.accent} strokeWidth={1.3} />
      </View>
      <Text style={styles.emptyTitle}>
        {isEs ? 'Sin mensajes aún' : 'Nothing to read yet'}
      </Text>
      <Text style={styles.emptyBody}>
        {isEs
          ? 'Tu despachador te enviará mensajes aquí sobre rutas y actualizaciones.'
          : 'Dispatcher updates, route changes, and messages will show here.'}
      </Text>
      <View style={styles.emptyHelper}>
        <View style={[styles.emptyHelperDot, { backgroundColor: palette.success }]} />
        <Text style={styles.emptyHelperText}>
          {isEs
            ? 'Te avisaremos cuando haya algo nuevo'
            : "We'll notify you when something arrives"}
        </Text>
      </View>
    </View>
  );
};

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
    topBarTitle: {
      ...typeScale.headingLg,
      color: palette.textPrimary,
    },
    topBarBtn: {
      width: 44,
      height: 44,
      borderRadius: radii.full,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Thread row
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: sp.screenPx,
      paddingVertical: sp.listPy,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.borderSubtle,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: radii.full,
      backgroundColor: palette.accentTint,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    avatarText: {
      fontSize: 15,
      fontWeight: '700',
      color: palette.accent,
      letterSpacing: 0.2,
    },
    rowHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 8,
    },
    name: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    timestamp: {
      fontSize: 11,
      color: palette.textTertiary,
      fontVariant: ['tabular-nums'],
    },
    previewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    },
    preview: {
      flex: 1,
      fontSize: 12,
      color: palette.textSecondary,
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 999,
      backgroundColor: palette.accent,
    },

    // Empty state — same vocabulary as dashboard's EmptyState
    emptyWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: sp.screenPx,
      paddingBottom: 48,
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
