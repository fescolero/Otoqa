/**
 * More — persona header + capability-gated sections. The Pay row exists
 * ONLY when the server says canViewSettlements (D3/D9): staff dispatchers
 * never see the section at all, not a locked version of it.
 */
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { useActiveAuth } from '../../lib/convex';
import { useDispatchSession } from './_layout';

export default function MoreScreen() {
  const session = useDispatchSession();
  const router = useRouter();
  const { signOut } = useActiveAuth();
  const personaLabel = session?.persona === 'owner_operator' ? 'Owner-operator' : 'Dispatcher';

  return (
    <View style={s.screen}>
      <Text style={s.title}>More</Text>

      <View style={s.card}>
        <Text style={s.orgName}>{session?.orgName ?? 'Organization'}</Text>
        <Text style={s.persona}>{personaLabel}</Text>
      </View>

      {session?.capabilities.canViewSettlements && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>PAY</Text>
          <Row
            icon="cash-outline"
            label="Pay & settlements"
            onPress={() => router.push('/pay')}
          />
        </View>
      )}

      <View style={s.section}>
        <Text style={s.sectionLabel}>ACCOUNT</Text>
        <Row icon="log-out-outline" label="Sign out" destructive onPress={() => void signOut()} />
      </View>

      <Text style={s.version}>Otoqa Dispatch · 1.0.0</Text>
    </View>
  );
}

function Row({
  icon,
  label,
  destructive,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const tint = destructive ? colors.destructive : colors.foreground;
  return (
    <Pressable style={s.row} onPress={onPress}>
      <Ionicons name={icon} size={18} color={tint} />
      <Text style={[s.rowLabel, { color: tint }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.foregroundMuted} />
    </Pressable>
  );
}

const s = {
  screen: { flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: 70 },
  title: { fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground },
  card: {
    marginTop: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    padding: 16,
  },
  orgName: { fontSize: typography.md, fontWeight: typography.semibold, color: colors.foreground },
  persona: { fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 3 },
  section: { marginTop: 22 },
  sectionLabel: {
    fontSize: typography.xs,
    fontWeight: typography.bold,
    letterSpacing: 1,
    color: colors.foregroundMuted,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  rowLabel: { flex: 1, fontSize: typography.base, fontWeight: typography.medium },
  version: {
    marginTop: 'auto' as const,
    textAlign: 'center' as const,
    color: colors.foregroundMuted,
    fontSize: typography.xs,
    paddingBottom: 16,
  },
};
