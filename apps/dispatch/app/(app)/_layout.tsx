/**
 * Signed-in shell — session gate + tab bar.
 *
 * One getSession query (dispatchMobile) drives everything: org context,
 * persona label, and capability flags (D3/D9). The UI renders ONLY from
 * these flags — never from which auth provider is active. Tabs match the
 * v8 design minus voice (Phase 3) and messages (dropped, D10).
 */
import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useConvexAuth, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { colors, typography } from '@otoqa/mobile-core';
import { useActiveAuth } from '../../lib/convex';

export type DispatchSession = NonNullable<ReturnType<typeof useDispatchSession>>;

const SessionContext = React.createContext<ReturnType<
  typeof useQuery<typeof api.dispatchMobile.getSession>
> | null>(null);

export function useDispatchSession() {
  return React.useContext(SessionContext);
}

export default function AppLayout() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useActiveAuth();
  const session = useQuery(api.dispatchMobile.getSession, isAuthenticated ? {} : 'skip');

  if (isLoading || (isAuthenticated && session === undefined)) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={s.muted}>Loading your board…</Text>
      </View>
    );
  }

  if (!isAuthenticated) return <Redirect href="/(auth)/sign-in" />;

  // Fail loud, not empty (§4.5): a signed-in user with no dispatch access
  // gets a clear dead-end, never silently blank screens.
  if (!session?.authenticated || !session.orgExternalId) {
    return (
      <View style={s.center}>
        <Ionicons name="shield-outline" size={44} color={colors.warning} />
        <Text style={s.deadEndTitle}>No dispatch access</Text>
        <Text style={s.deadEndText}>
          Your account isn't set up for dispatching. Ask your administrator to invite you, or sign
          in with a different account.
        </Text>
        <Pressable style={s.signOutBtn} onPress={() => void signOut()}>
          <Text style={s.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SessionContext.Provider value={session}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.foregroundMuted,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Board',
            tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="drivers"
          options={{
            title: 'Drivers',
            tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="notifications"
          options={{
            title: 'Notifications',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="notifications-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: 'More',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="ellipsis-horizontal-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
    </SessionContext.Provider>
  );
}

const s = {
  center: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: colors.background,
    padding: 28,
    gap: 10,
  },
  muted: { color: colors.foregroundMuted, fontSize: typography.sm },
  deadEndTitle: {
    color: colors.foreground,
    fontSize: typography.lg,
    fontWeight: typography.bold,
    marginTop: 6,
  },
  deadEndText: {
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    textAlign: 'center' as const,
    lineHeight: 20,
  },
  signOutBtn: { marginTop: 14, paddingVertical: 10, paddingHorizontal: 22 },
  signOutText: { color: colors.primary, fontSize: typography.base, fontWeight: typography.semibold },
};
