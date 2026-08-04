/**
 * Driver detail — profile + credentials (with expiration warnings),
 * current/next load (tap → load detail), last GPS fix age, and the last
 * 7 days of loads via listDriverHistory. Reached from the Drivers tab.
 */
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { displayLoadId } from '../../lib/format';
import type { Id } from '@otoqa/convex-client';

const DAY_MS = 86_400_000;

const daysUntil = (iso?: string | null): number | null => {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / DAY_MS);
};

const agoLabel = (ms: number): string => {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

function CredRow({ label, date }: { label: string; date: string | null }) {
  const days = daysUntil(date);
  const tone =
    days === null ? colors.foregroundMuted : days < 0 ? colors.destructive : days <= 30 ? colors.warning : colors.foreground;
  const suffix = days === null ? '' : days < 0 ? ' · expired' : days <= 30 ? ` · ${days}d left` : '';
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>{label}</Text>
      <Text style={{ color: tone, fontSize: typography.sm, fontWeight: typography.medium }}>
        {date ? `${date.slice(0, 10)}${suffix}` : '—'}
      </Text>
    </View>
  );
}

function LoadRow({
  title,
  load,
  onPress,
}: {
  title: string;
  load: { internalId: string; customerName: string | null; tripNumber: string | null; hcr: string | null };
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 10 }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase' }}>
        {title}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold }}>
          {displayLoadId(load.internalId)}
          {load.customerName ? (
            <Text style={{ color: colors.foregroundMuted, fontWeight: typography.medium }}> {load.customerName}</Text>
          ) : null}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.foregroundMuted} />
      </View>
      {(load.tripNumber || load.hcr) && (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 3 }}>
          {[load.tripNumber ? `Trip ${load.tripNumber}` : null, load.hcr ? `HCR ${load.hcr}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )}
    </Pressable>
  );
}

export default function DriverDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const driverId = id as Id<'drivers'> | undefined;
  const driver = useQuery(api.dispatchMobile.getDriverDetail, driverId ? { driverId } : 'skip');
  // Last 7 local days, today inclusive.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const history = useQuery(
    api.dispatchMobile.listDriverHistory,
    driverId
      ? { driverId, dayStartMs: dayStart.getTime() - 6 * DAY_MS, dayEndMs: dayStart.getTime() + DAY_MS }
      : 'skip',
  );

  if (driver === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (driver === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Ionicons name="person-outline" size={40} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 10 }}>Driver not found.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontSize: typography.sm, fontWeight: typography.semibold }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const statusWord = (s: string) =>
    s === 'COMPLETED' ? 'completed' : s === 'IN_PROGRESS' ? 'in transit' : 'scheduled';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground, flex: 1 }} numberOfLines={1}>
          {driver.firstName} {driver.lastName}
        </Text>
        <Text style={{ color: driver.employmentStatus === 'Active' ? colors.primary : colors.warning, fontSize: typography.xs, fontWeight: typography.bold }}>
          {driver.employmentStatus}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          {driver.phone ? (
            <Pressable
              onPress={() => void Linking.openURL(`tel:${driver.phone}`)}
              style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, backgroundColor: colors.primary, paddingVertical: 12, borderRadius: borderRadius.md }}
            >
              <Ionicons name="call-outline" size={17} color={colors.primaryForeground} />
              <Text style={{ color: colors.primaryForeground, fontSize: typography.sm, fontWeight: typography.semibold }}>Call</Text>
            </Pressable>
          ) : null}
          {driver.email ? (
            <Pressable
              onPress={() => void Linking.openURL(`mailto:${driver.email}`)}
              style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.border, paddingVertical: 12, borderRadius: borderRadius.md }}
            >
              <Ionicons name="mail-outline" size={17} color={colors.foreground} />
              <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>Email</Text>
            </Pressable>
          ) : null}
        </View>

        {driver.lastFixAt && (
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginBottom: 14 }}>
            Last GPS fix {agoLabel(driver.lastFixAt)}
          </Text>
        )}

        {/* HOS estimate (D11) — session-derived, always labeled (est). */}
        <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons
              name="time-outline"
              size={18}
              color={
                driver.hos.onShift && (driver.hos.windowRemainingHours ?? 14) < 3
                  ? colors.warning
                  : colors.primary
              }
            />
            <Text style={{ flex: 1, color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
              {driver.hosLabel}
            </Text>
          </View>
          <Text style={{ color: driver.hos.cycleRemainingHours < 5 ? colors.warning : colors.foregroundMuted, fontSize: typography.xs, marginTop: 5 }}>
            {driver.hos.cycleUsedHours}h of 70h used in the last 8 days · ~
            {driver.hos.cycleRemainingHours}h left (est)
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 5, lineHeight: 16 }}>
            Estimated from shift sessions — not an ELD record.
          </Text>
        </View>

        {driver.currentLoad && (
          <LoadRow
            title="Current load"
            load={driver.currentLoad}
            onPress={() => router.push({ pathname: '/load/[id]', params: { id: driver.currentLoad!._id } })}
          />
        )}
        {driver.nextLoad && (
          <LoadRow
            title="Next load"
            load={driver.nextLoad}
            onPress={() => router.push({ pathname: '/load/[id]', params: { id: driver.nextLoad!._id } })}
          />
        )}

        <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 12 }}>
          <CredRow label={`License (Class ${driver.licenseClass} · ${driver.licenseState})`} date={driver.licenseExpiration} />
          <CredRow label="Medical card" date={driver.medicalExpiration} />
          {driver.twicExpiration ? <CredRow label="TWIC" date={driver.twicExpiration} /> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>Employment</Text>
            <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.medium }}>
              {driver.employmentType} · since {driver.hireDate.slice(0, 10)}
            </Text>
          </View>
        </View>

        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginTop: 8, marginBottom: 8 }}>
          Last 7 days{history ? ` · ${history.length} load${history.length === 1 ? '' : 's'}` : ''}
        </Text>
        {history === undefined ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
        ) : history.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>No loads in the last 7 days.</Text>
        ) : (
          history.map((l) => (
            <View
              key={l._id}
              style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 12, marginBottom: 8 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                  {displayLoadId(l.internalId)}
                </Text>
                <Text style={{ color: l.status === 'IN_PROGRESS' ? colors.primary : colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold }}>
                  {statusWord(l.status)}
                </Text>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 3 }}>
                {[
                  l.customerName,
                  l.tripNumber ? `Trip ${l.tripNumber}` : null,
                  l.hcr ? `HCR ${l.hcr}` : null,
                  `${l.stopCount} stop${l.stopCount === 1 ? '' : 's'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
