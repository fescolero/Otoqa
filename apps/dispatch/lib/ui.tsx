/**
 * Shared dispatch primitives — the React Native counterparts of the v8
 * design's `lib-dispatch/ui.jsx`.
 *
 * Lives in lib/ rather than app/ because Expo Router treats every file under
 * app/ as a route.
 *
 * Kept deliberately small and presentational: these take plain values, never
 * Convex documents, so the Board, Drivers list and driver detail can all
 * reach for the same chip without agreeing on a query shape first.
 */
import { Text, TextInput, View, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { borderRadius, colors, typography } from './theme';

/**
 * The design's avatar hues, ported from oklch (unsupported in RN) to the
 * nearest HSL. Index is derived from the id so a driver keeps their color
 * between renders and between screens.
 */
const AVATAR_HUES = [212, 268, 158, 24, 340, 190, 44, 300];

export function avatarHue(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return AVATAR_HUES[sum % AVATAR_HUES.length];
}

export function initials(first?: string | null, last?: string | null): string {
  const a = (first ?? '').trim();
  const b = (last ?? '').trim();
  const letters = `${a.charAt(0)}${b.charAt(0)}`.toUpperCase();
  return letters || '?';
}

export type DriverStatus = 'moving' | 'idle' | 'late' | 'offline';

export const DRIVER_STATUS: Record<DriverStatus, { color: string; label: string; tint: string }> = {
  moving: { color: colors.primary, label: 'Moving', tint: colors.accentTint },
  idle: { color: colors.success, label: 'Available', tint: 'rgba(16,185,129,0.12)' },
  late: { color: colors.warning, label: 'Running late', tint: 'rgba(245,158,11,0.14)' },
  offline: { color: colors.foregroundSubtle, label: 'Offline', tint: colors.muted },
};

export function Avatar({
  id,
  first,
  last,
  size = 40,
}: {
  id: string;
  first?: string | null;
  last?: string | null;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: `hsl(${avatarHue(id)}, 42%, 44%)`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontWeight: typography.bold, fontSize: size * 0.36 }}>
        {initials(first, last)}
      </Text>
    </View>
  );
}

/** Avatar with the design's status dot notched into the bottom-right. */
export function AvatarWithStatus({
  id,
  first,
  last,
  status,
  size = 40,
}: {
  id: string;
  first?: string | null;
  last?: string | null;
  status: DriverStatus;
  size?: number;
}) {
  const dot = Math.round(size * 0.3);
  return (
    <View style={{ position: 'relative' }}>
      <Avatar id={id} first={first} last={last} size={size} />
      <View
        style={{
          position: 'absolute',
          right: -1,
          bottom: -1,
          width: dot,
          height: dot,
          borderRadius: 999,
          backgroundColor: (DRIVER_STATUS[status] ?? DRIVER_STATUS.idle).color,
          borderWidth: 2,
          borderColor: colors.background,
        }}
      />
    </View>
  );
}

export function StatusPill({ status }: { status: DriverStatus }) {
  const s = DRIVER_STATUS[status] ?? DRIVER_STATUS.idle;
  return (
    <View
      style={{
        backgroundColor: s.tint,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: borderRadius.full,
      }}
    >
      <Text style={{ color: s.color, fontSize: typography.xs, fontWeight: typography.bold }}>
        {s.label}
      </Text>
    </View>
  );
}

/**
 * Hours-of-service bar (D11 — a session-derived *estimate*, never an ELD
 * reading). On shift it tracks what's left of the 14h window; off shift, the
 * 70h cycle. The design's colour thresholds are hours-remaining, not a
 * percentage, so a long cycle doesn't read "green" at 2h left.
 */
export function HosBar({
  onShift,
  windowRemainingHours,
  cycleRemainingHours,
  width = 44,
}: {
  onShift: boolean;
  windowRemainingHours: number | null;
  cycleRemainingHours: number;
  width?: number;
}) {
  const remaining = onShift ? (windowRemainingHours ?? 0) : cycleRemainingHours;
  const max = onShift ? 14 : 70;
  const pct = Math.max(0.04, Math.min(1, remaining / max));
  const color = remaining < 2 ? colors.error : remaining < 4 ? colors.warning : colors.success;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View
        style={{
          width,
          height: 4,
          borderRadius: 999,
          backgroundColor: colors.subtle,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: color, borderRadius: 999 }} />
      </View>
      <Text style={{ fontSize: typography.sm, fontWeight: typography.semibold, color }}>
        {`${Math.round(remaining)}h`}
      </Text>
    </View>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        height: 42,
        paddingHorizontal: 12,
        borderRadius: borderRadius.md,
        backgroundColor: colors.muted,
      }}
    >
      <Ionicons name="search" size={17} color={colors.foregroundSubtle} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundSubtle}
        autoCorrect={false}
        style={{ flex: 1, fontSize: typography.base, color: colors.foreground }}
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChangeText('')} hitSlop={10}>
          <Ionicons name="close-circle" size={17} color={colors.foregroundSubtle} />
        </Pressable>
      )}
    </View>
  );
}

export interface SegItem<K extends string> {
  k: K;
  label: string;
}

/** Pill filter row. Scrolls horizontally so extra filters never wrap. */
export function SegRow<K extends string>({
  items,
  value,
  onChange,
  counts,
}: {
  items: SegItem<K>[];
  value: K;
  onChange: (k: K) => void;
  counts?: Partial<Record<K, number>>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 24 }}
    >
      {items.map((it) => {
        const on = it.k === value;
        return (
          <Pressable
            key={it.k}
            onPress={() => onChange(it.k)}
            style={{
              minHeight: 34,
              paddingHorizontal: 12,
              borderRadius: borderRadius.full,
              backgroundColor: on ? colors.primary : colors.muted,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Text
              style={{
                fontSize: typography.base,
                fontWeight: typography.semibold,
                color: on ? colors.primaryForeground : colors.foregroundMuted,
              }}
            >
              {it.label}
            </Text>
            {counts?.[it.k] != null && (
              <View
                style={{
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 999,
                  backgroundColor: on ? 'rgba(255,255,255,0.22)' : colors.subtle,
                }}
              >
                <Text
                  style={{
                    fontSize: typography.xs,
                    fontWeight: typography.bold,
                    color: on ? '#fff' : colors.foregroundSubtle,
                  }}
                >
                  {counts[it.k]}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
