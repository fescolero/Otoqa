/** Assign sheet — ranked candidates per §5.1/v8: best match on top, warned
 * candidates ranked (never hidden), conflict-aware assignment (§4.6). */
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api, type Id } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

export default function AssignScreen() {
  const router = useRouter();
  const { assignmentId } = useLocalSearchParams<{ assignmentId: string }>();
  const id = assignmentId as Id<'loadCarrierAssignments'>;
  const ranked = useQuery(api.dispatchMobile.suggestDriversForLoad, id ? { assignmentId: id } : 'skip');
  const assign = useMutation(api.dispatchMobile.assignDriverToLoad);

  const pick = async (driverId: Id<'drivers'>) => {
    const res = await assign({ assignmentId: id, driverId });
    if (res.success) {
      router.back();
    } else {
      Alert.alert('Already assigned', `This load was just assigned to ${res.alreadyAssigned.driverName}.`);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
          Assign driver
        </Text>
      </View>
      {ranked === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : ranked.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, textAlign: 'center', marginTop: 48 }}>
          No drivers in your organization yet.
        </Text>
      ) : (
        <FlatList
          data={ranked}
          keyExtractor={(r) => r._id}
          contentContainerStyle={{ padding: 20, gap: 10 }}
          renderItem={({ item, index }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: index === 0 ? colors.primary : colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                  {item.firstName} {item.lastName}
                  {index === 0 && <Text style={{ color: colors.primary, fontSize: typography.xs }}>  BEST</Text>}
                </Text>
                <Pressable
                  onPress={() => pick(item._id)}
                  style={{ backgroundColor: colors.primary, borderRadius: borderRadius.md, paddingHorizontal: 14, paddingVertical: 8 }}
                >
                  <Text style={{ color: colors.primaryForeground, fontWeight: typography.semibold, fontSize: typography.sm }}>Assign</Text>
                </Pressable>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 4 }}>
                {item.milesFromPickup != null ? `${item.milesFromPickup} mi from pickup · ` : ''}
                {item.activeLoads} active load{item.activeLoads === 1 ? '' : 's'}
              </Text>
              <Text
                style={{
                  color:
                    item.hos.onShift && (item.hos.windowRemainingHours ?? 14) < 3
                      ? colors.warning
                      : colors.foregroundMuted,
                  fontSize: typography.xs,
                  marginTop: 3,
                }}
              >
                {item.hosLabel}
              </Text>
              {item.warns.length > 0 && (
                <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 4 }}>
                  {item.warns.join(' · ')}
                </Text>
              )}
            </View>
          )}
        />
      )}
    </View>
  );
}
