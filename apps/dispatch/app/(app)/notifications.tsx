/** Notifications — live dispatchAlerts feed (§5.2, v8 design): operational
 * failures tiered "Costing money now" (high) / "Needs a look" (med), with
 * Call driver (D10: no in-app messaging) and dismiss actions. */
import { ActivityIndicator, Linking, Pressable, SectionList, Text, View } from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../../lib/theme';

const KIND_LABEL: Record<string, string> = {
  TRACKING_LOST: 'Tracking lost',
  MISSED_APPOINTMENT: 'Appointment missed',
  POD_MISSING: 'POD missing',
  LOAD_CANCELED: 'Load canceled',
  OFFER_DECLINED: 'Offer declined',
};

export default function NotificationsScreen() {
  const alerts = useQuery(api.dispatchAlerts.listAlerts, {});
  const dismiss = useMutation(api.dispatchAlerts.dismissAlert);

  const sections =
    alerts === undefined
      ? []
      : [
          { title: 'Costing money now', data: alerts.filter((a) => a.severity === 'high') },
          { title: 'Needs a look', data: alerts.filter((a) => a.severity === 'med') },
        ].filter((s) => s.data.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
          Notifications
        </Text>
      </View>
      {alerts === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : sections.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 48, paddingHorizontal: 32 }}>
          <Ionicons name="checkmark-circle" size={36} color={colors.success ?? colors.primary} />
          <Text style={{ color: colors.foreground, fontWeight: typography.semibold, marginTop: 8 }}>
            Nothing slipping
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 4, textAlign: 'center' }}>
            Every load is tracked and on schedule.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(a) => a._id}
          contentContainerStyle={{ padding: 24, gap: 10 }}
          renderSectionHeader={({ section }) => (
            <Text style={{ color: section.title === 'Costing money now' ? colors.destructive : colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginTop: 8, marginBottom: 4 }}>
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: item.severity === 'high' ? colors.destructive : colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold }}>
                  {KIND_LABEL[item.kind] ?? item.kind}
                  {item.loadInternalId ? `  ·  #${item.loadInternalId}` : ''}
                </Text>
                <Pressable onPress={() => void dismiss({ alertId: item._id })} hitSlop={8}>
                  <Ionicons name="close" size={18} color={colors.foregroundMuted} />
                </Pressable>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 4, lineHeight: 19 }}>
                {item.detail}
              </Text>
              {item.driver?.phone && (
                <Pressable
                  onPress={() => void Linking.openURL(`tel:${item.driver!.phone}`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, paddingHorizontal: 12, paddingVertical: 7 }}
                >
                  <Ionicons name="call-outline" size={14} color={colors.primary} />
                  <Text style={{ color: colors.primary, fontSize: typography.sm, fontWeight: typography.semibold }}>
                    Call {item.driver.firstName}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        />
      )}
    </View>
  );
}
