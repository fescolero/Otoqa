/** Board — live AWARDED/IN_PROGRESS assignments via dispatchMobile.listActiveAssignments. */
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { useDispatchSession } from './_layout';

export default function BoardScreen() {
  const session = useDispatchSession();
  const router = useRouter();
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
          Board
        </Text>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          {session?.orgName ?? ''}{rows ? ` · ${rows.length} active` : ''}
        </Text>
      </View>
      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          No loads on the board yet.{'\n'}Loads assigned to your organization appear here.
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r._id}
          contentContainerStyle={{ padding: 24, gap: 10 }}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push({ pathname: '/assign', params: { assignmentId: item._id } })} style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                  #{item.load?.internalId ?? '—'}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Pressable onPress={() => router.push({ pathname: '/adjust', params: { assignmentId: item._id } })} hitSlop={8}>
                    <Ionicons name='time-outline' size={18} color={colors.foregroundMuted} />
                  </Pressable>
                  <Text style={{ color: item.status === 'IN_PROGRESS' ? colors.primary : colors.warning, fontSize: typography.xs, fontWeight: typography.bold }}>
                    {item.status === 'IN_PROGRESS' ? 'In transit' : 'Awarded'}
                  </Text>
                </View>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
                {item.load?.customerName ?? 'Customer'} · {item.stops.length} stop{item.stops.length === 1 ? '' : 's'}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 2 }}>
                {item.driver ? `${item.driver.firstName} ${item.driver.lastName}` : 'No driver assigned'}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
