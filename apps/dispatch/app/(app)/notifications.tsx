/**
 * Notifications — live dispatchAlerts feed (§5.2, design
 * `lib-dispatch/notifications.jsx`).
 *
 * Operational failures tiered "Costing money now" (high) / "Needs a look"
 * (med). Every card carries the action that actually resolves it — re-time
 * the window, reassign the load, call the driver — because a feed that only
 * reports problems makes a dispatcher go find the screen that fixes them.
 *
 * No Messages segment: chat is dropped product-wide (D10), so contact is
 * Call driver.
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, SectionList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../../lib/theme';
import { Avatar, SegRow } from '../../lib/ui';
import { displayLoadId } from '../../lib/format';
import {
  ALERT_FILTERS,
  alertActions,
  alertIcon,
  alertLabel,
  formatAge,
  matchesAlertFilter,
  type AlertAction,
  type AlertFilter,
} from '../../lib/alerts';

type Alert = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchAlerts.listAlerts>>>[number];

const SEV = {
  high: { fg: colors.error, tint: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.30)' },
  med: { fg: colors.warning, tint: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)' },
} as const;

function ActionButton({
  action,
  filled,
  onPress,
}: {
  action: AlertAction;
  filled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: filled ? 1 : undefined,
        minHeight: 40,
        paddingHorizontal: 14,
        borderRadius: borderRadius.lg,
        backgroundColor: filled ? colors.primary : 'transparent',
        borderWidth: filled ? 0 : 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: filled ? colors.primaryForeground : colors.foreground,
          fontSize: typography.base,
          fontWeight: typography.semibold,
        }}
      >
        {action.label}
      </Text>
    </Pressable>
  );
}

function AlertCard({
  alert,
  now,
  onDismiss,
  onAction,
  onDriver,
  onLoad,
}: {
  alert: Alert;
  now: number;
  onDismiss: () => void;
  onAction: (a: AlertAction) => void;
  onDriver: () => void;
  onLoad: () => void;
}) {
  const sev = SEV[alert.severity as 'high' | 'med'] ?? SEV.med;
  const { primary, secondary } = alertActions({
    kind: alert.kind,
    driver: alert.driver,
    loadId: alert.loadId ?? null,
    assignmentId: alert.assignmentId ?? null,
  });

  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: sev.border,
        borderRadius: borderRadius.lg,
        padding: 13,
        gap: 10,
        marginBottom: 10,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: borderRadius.md,
            backgroundColor: sev.tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={alertIcon(alert.kind) as never} size={16} color={sev.fg} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <Text
              style={{
                fontSize: typography.md,
                fontWeight: typography.bold,
                color: colors.foreground,
              }}
            >
              {alertLabel(alert.kind)}
            </Text>
            <Text style={{ fontSize: typography.xs, color: colors.foregroundSubtle }}>
              {formatAge(alert.createdAt, now)}
            </Text>
          </View>
          <Text
            style={{
              fontSize: typography.sm,
              color: colors.foregroundMuted,
              marginTop: 4,
              lineHeight: 18,
            }}
          >
            {alert.detail}
          </Text>
        </View>
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityLabel="Dismiss">
          <Ionicons name="close" size={16} color={colors.foregroundSubtle} />
        </Pressable>
      </View>

      {/* Who and what — both tappable, so the card is also a way in. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {alert.driver && (
          <Pressable
            onPress={onDriver}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingRight: 8,
              paddingLeft: 2,
              height: 26,
              borderRadius: borderRadius.full,
              backgroundColor: colors.muted,
            }}
          >
            <Avatar
              id={alert.driver._id}
              first={alert.driver.firstName}
              last={alert.driver.lastName}
              size={22}
            />
            <Text
              style={{
                fontSize: typography.sm,
                fontWeight: typography.semibold,
                color: colors.foregroundMuted,
              }}
            >
              {alert.driver.firstName} {alert.driver.lastName}
            </Text>
          </Pressable>
        )}
        {alert.loadInternalId && (
          <Pressable onPress={onLoad} hitSlop={6}>
            <Text
              style={{
                fontSize: typography.sm,
                fontWeight: typography.bold,
                color: colors.primary,
              }}
            >
              {displayLoadId(alert.loadInternalId)}
            </Text>
          </Pressable>
        )}
      </View>

      {(primary || secondary) && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {primary && <ActionButton action={primary} filled onPress={() => onAction(primary)} />}
          {secondary && (
            <ActionButton action={secondary} filled={false} onPress={() => onAction(secondary)} />
          )}
        </View>
      )}
    </View>
  );
}

export default function NotificationsScreen() {
  const alerts = useQuery(api.dispatchAlerts.listAlerts, {});
  const dismiss = useMutation(api.dispatchAlerts.dismissAlert);
  const router = useRouter();
  const [filter, setFilter] = useState<AlertFilter>('all');

  // Ages tick on their own. A feed whose "4m ago" freezes until the next
  // query update understates how stale an alert is — the one number a
  // dispatcher reads to decide how hard to chase it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const base: Partial<Record<AlertFilter, number>> = {};
    for (const { k } of ALERT_FILTERS) {
      base[k] = (alerts ?? []).filter((a) => matchesAlertFilter(a.kind, k)).length;
    }
    return base;
  }, [alerts]);

  const visible = useMemo(
    () => (alerts ?? []).filter((a) => matchesAlertFilter(a.kind, filter)),
    [alerts, filter],
  );

  const sections = useMemo(
    () =>
      [
        { title: 'Costing money now', tone: colors.error, data: visible.filter((a) => a.severity === 'high') },
        { title: 'Needs a look', tone: colors.foregroundSubtle, data: visible.filter((a) => a.severity === 'med') },
      ].filter((s) => s.data.length > 0),
    [visible],
  );

  const runAction = (alert: Alert, action: AlertAction) => {
    switch (action.kind) {
      case 'call':
        if (alert.driver?.phone) void Linking.openURL(`tel:${alert.driver.phone}`);
        return;
      case 'load':
        if (alert.loadId) router.push({ pathname: '/load/[id]', params: { id: alert.loadId } });
        return;
      case 'map':
        router.push('/map');
        return;
      case 'assign':
        router.push({ pathname: '/assign', params: { assignmentId: alert.assignmentId } });
        return;
      case 'adjust':
        router.push({ pathname: '/adjust', params: { assignmentId: alert.assignmentId } });
        return;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <Text
          style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}
        >
          Notifications
        </Text>
        {alerts && alerts.length > 0 && (
          <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 4 }}>
            {alerts.filter((a) => a.severity === 'high').length} costing money ·{' '}
            {alerts.filter((a) => a.severity === 'med').length} to look at
          </Text>
        )}
      </View>

      {alerts === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : alerts.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 48, paddingHorizontal: 32 }}>
          <Ionicons name="checkmark-circle" size={36} color={colors.success} />
          <Text style={{ color: colors.foreground, fontWeight: typography.semibold, marginTop: 8 }}>
            Nothing slipping
          </Text>
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: typography.sm,
              marginTop: 4,
              textAlign: 'center',
            }}
          >
            Every load is tracked and on schedule.
          </Text>
        </View>
      ) : (
        <>
          <View style={{ paddingTop: 14 }}>
            <SegRow value={filter} onChange={setFilter} counts={counts} items={ALERT_FILTERS} />
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(a) => a._id}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingTop: 8 }}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <Text
                style={{
                  color: section.tone,
                  fontSize: typography.xs,
                  fontWeight: typography.bold,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  marginTop: 8,
                  marginBottom: 6,
                }}
              >
                {section.title} · {section.data.length}
              </Text>
            )}
            renderItem={({ item }) => (
              <AlertCard
                alert={item}
                now={now}
                onDismiss={() => void dismiss({ alertId: item._id })}
                onAction={(a) => runAction(item, a)}
                onDriver={() =>
                  item.driver &&
                  router.push({ pathname: '/driver/[id]', params: { id: item.driver._id } })
                }
                onLoad={() =>
                  item.loadId && router.push({ pathname: '/load/[id]', params: { id: item.loadId } })
                }
              />
            )}
            ListEmptyComponent={
              <Text
                style={{
                  color: colors.foregroundSubtle,
                  fontSize: typography.base,
                  textAlign: 'center',
                  paddingVertical: 40,
                }}
              >
                Nothing in this filter.
              </Text>
            }
          />
        </>
      )}
    </View>
  );
}
