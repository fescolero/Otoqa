/**
 * Assign sheet — ranked candidates per §5.1/v8: best match on top, warned
 * candidates ranked (never hidden), conflict-aware assignment (§4.6).
 *
 * Serves both backlogs, because the board shows both. A brokered load is
 * keyed by its carrier assignment and commits through assignDriverToLoad; an
 * open TMS load has no assignment to key on, so it is keyed by loadId and
 * commits through assignDriverToLoadsWeb — which creates the leg that
 * dispatching a load actually means. Same scorer either way.
 */
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api, type Id } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../lib/theme';
import { SearchField } from '../lib/ui';

/** Below this many candidates, scrolling is quicker than typing. */
const SEARCH_THRESHOLD = 6;

export default function AssignScreen() {
  const router = useRouter();
  const { assignmentId, loadId } = useLocalSearchParams<{
    assignmentId?: string;
    loadId?: string;
  }>();
  const id = assignmentId as Id<'loadCarrierAssignments'> | undefined;
  const openId = loadId as Id<'loadInformation'> | undefined;

  const rankedAssignment = useQuery(
    api.dispatchMobile.suggestDriversForLoad,
    id ? { assignmentId: id } : 'skip',
  );
  const rankedOpen = useQuery(
    api.dispatchMobile.suggestDriversForTmsLoad,
    !id && openId ? { loadId: openId } : 'skip',
  );
  const ranked = id ? rankedAssignment : rankedOpen;

  const assign = useMutation(api.dispatchMobile.assignDriverToLoad);
  const assignWeb = useMutation(api.dispatchMobile.assignDriverToLoadsWeb);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  // Filter, never re-rank: the order is the scorer's answer to "who should
  // take this", and typing a name is a way to reach a driver, not a claim
  // about fit.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !ranked) return ranked ?? [];
    return ranked.filter((r) =>
      `${r.firstName ?? ''} ${r.lastName ?? ''} ${r.phone ?? ''}`.toLowerCase().includes(needle),
    );
  }, [ranked, q]);

  // BEST belongs to the top-ranked driver, not to whoever lands in row 0
  // once a search narrows the list.
  const bestId = ranked?.[0]?._id ?? null;

  const pick = async (driverId: Id<'drivers'>) => {
    setBusy(true);
    try {
      if (id) {
        const res = await assign({ assignmentId: id, driverId });
        if (res.success) {
          router.back();
        } else {
          Alert.alert(
            'Already assigned',
            `This load was just assigned to ${res.alreadyAssigned.driverName}.`,
          );
        }
        return;
      }
      if (openId) {
        await assignWeb({ loadIds: [openId], driverId });
        router.back();
      }
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
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
          data={visible}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            ranked.length > SEARCH_THRESHOLD ? (
              <View style={{ paddingBottom: 12 }}>
                <SearchField
                  value={q}
                  onChangeText={setQ}
                  placeholder={`Search ${ranked.length} drivers`}
                />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text
              style={{
                color: colors.foregroundSubtle,
                fontSize: typography.base,
                textAlign: 'center',
                paddingVertical: 40,
              }}
            >
              No drivers match.
            </Text>
          }
          keyExtractor={(r) => r._id}
          contentContainerStyle={{ padding: 20, gap: 10 }}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: item._id === bestId ? colors.primary : colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                  {item.firstName} {item.lastName}
                  {item._id === bestId && (
                    <Text style={{ color: colors.primary, fontSize: typography.xs }}>  BEST</Text>
                  )}
                </Text>
                <Pressable
                  disabled={busy}
                  onPress={() => void pick(item._id)}
                  style={{ backgroundColor: colors.primary, borderRadius: borderRadius.md, paddingHorizontal: 14, paddingVertical: 8, opacity: busy ? 0.6 : 1 }}
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
