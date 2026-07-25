/** Drivers — live fleet list via dispatchMobile.listDrivers. */
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

export default function DriversScreen() {
  const rows = useQuery(api.dispatchMobile.listDrivers, {});
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
          Drivers
        </Text>
        <Pressable onPress={() => router.push('/map')} hitSlop={10}>
          <Ionicons name="map-outline" size={22} color={colors.primary} />
        </Pressable>
        {rows && (
          <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
            {rows.length} active
          </Text>
        )}
      </View>
      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          No drivers yet.{'\n'}Drivers added to your organization appear here.
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r._id}
          contentContainerStyle={{ padding: 24, gap: 10 }}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
              <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                {item.firstName} {item.lastName}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
                {item.currentLoad ? `On load #${item.currentLoad.internalId}` : 'Available'}
                {item.phone ? ` · ${item.phone}` : ''}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}
