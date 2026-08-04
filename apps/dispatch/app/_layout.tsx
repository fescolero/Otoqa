/**
 * Otoqa Dispatch — root layout. Providers only:
 * PostHog (D17/D18) → Clerk (owner-operator phone OTP) → dual-source
 * Convex auth → router.
 * No location/camera/mic anywhere in this app (decision D6).
 */
import * as React from 'react';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { ClerkProvider } from '@clerk/clerk-expo';
import { PostHogProvider, usePostHog } from 'posthog-react-native';
import { colors, typography } from '@otoqa/mobile-core';
import { DispatchAuthProvider } from '../lib/convex';
import {
  getAppVersionContext,
  installGlobalErrorTracking,
  setPostHogClient,
  trackError,
  trackScreen,
} from '../lib/analytics';

import { CLERK_PUBLISHABLE_KEY, POSTHOG_HOST, POSTHOG_KEY } from '../lib/env';

// Same SecureStore token cache shape as the driver app.
const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      return;
    }
  },
};

installGlobalErrorTracking();

function PostHogInit() {
  const posthog = usePostHog();
  useEffect(() => {
    if (posthog) {
      setPostHogClient(posthog);
      posthog.capture('app_started', getAppVersionContext());
    }
  }, [posthog]);
  return null;
}

function ScreenTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) trackScreen(pathname);
  }, [pathname]);
  return null;
}

/** Render crashes become a recoverable screen + a PostHog event instead of
 *  a silent close (and, on a fresh OTA, a silent rollback). */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    trackError('error_boundary', error.message || 'Unknown render error', {
      component_stack: info.componentStack ?? null,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 32, gap: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: typography.lg, fontWeight: typography.bold }}>
            Something went wrong
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', lineHeight: 20 }}>
            {this.state.error.message}
          </Text>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, marginTop: 8 }}
          >
            <Text style={{ color: colors.primaryForeground, fontWeight: typography.semibold }}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <PostHogProvider
        apiKey={POSTHOG_KEY}
        options={{ host: POSTHOG_HOST, flushAt: 5, flushInterval: 3000 }}
      >
        <PostHogInit />
        <ScreenTracker />
        <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
          <DispatchAuthProvider>
            <StatusBar style="auto" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            />
          </DispatchAuthProvider>
        </ClerkProvider>
      </PostHogProvider>
    </ErrorBoundary>
  );
}
