/**
 * More — persona header + capability-gated sections. The Pay row exists
 * ONLY when the server says canViewSettlements (D3/D9): staff dispatchers
 * never see the section at all, not a locked version of it.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { useActiveAuth } from '../../lib/convex';
import { useDispatchSession } from './_layout';

// Lazy require — same OTA-safety rule as the other native modules.
/* eslint-disable @typescript-eslint/no-var-requires */
let Updates: {
  updateId: string | null;
  isEmbeddedLaunch: boolean;
  channel: string | null;
  runtimeVersion: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean }>;
  reloadAsync(): Promise<void>;
} | null = null;
try {
  Updates = require('expo-updates');
} catch {
  Updates = null;
}
/* eslint-enable @typescript-eslint/no-var-requires */

export default function MoreScreen() {
  const session = useDispatchSession();
  const router = useRouter();
  const { signOut } = useActiveAuth();
  const personaLabel = session?.persona === 'owner_operator' ? 'Owner-operator' : 'Dispatcher';
  const [updStatus, setUpdStatus] = useState('');

  // Manual OTA check: surfaces download/apply errors that the silent
  // launch-time check (and its crash-rollback) never shows.
  const checkForUpdate = async () => {
    if (!Updates) return setUpdStatus('Updates unavailable in this build.');
    setUpdStatus('Checking…');
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) return setUpdStatus('Already up to date.');
      setUpdStatus('Downloading…');
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew) return setUpdStatus('Downloaded, but not newer than the running bundle.');
      setUpdStatus('Restarting with the new version…');
      await Updates.reloadAsync();
    } catch (e) {
      setUpdStatus(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const bundleTag = Updates
    ? Updates.isEmbeddedLaunch || !Updates.updateId
      ? 'embedded js'
      : `ota ${String(Updates.updateId).slice(0, 8)}`
    : 'dev';
  const channelTag = Updates?.channel ? ` · ${Updates.channel}` : '';

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
        <Text style={s.sectionLabel}>APP</Text>
        <Row icon="refresh-outline" label="Check for updates" onPress={() => void checkForUpdate()} />
        {updStatus !== '' && <Text style={s.updStatus}>{updStatus}</Text>}
      </View>

      <View style={s.section}>
        <Text style={s.sectionLabel}>ACCOUNT</Text>
        <Row icon="log-out-outline" label="Sign out" destructive onPress={() => void signOut()} />
      </View>

      <Text style={s.version}>
        Otoqa Dispatch · 1.0.0 · {bundleTag}
        {channelTag}
      </Text>
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
  updStatus: {
    marginTop: 8,
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    lineHeight: 18,
  },
  version: {
    marginTop: 'auto' as const,
    textAlign: 'center' as const,
    color: colors.foregroundMuted,
    fontSize: typography.xs,
    paddingBottom: 16,
  },
};
