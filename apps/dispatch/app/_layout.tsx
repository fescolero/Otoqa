/**
 * Otoqa Dispatch — root layout. Providers only:
 * Clerk (owner-operator phone OTP) → dual-source Convex auth → router.
 * No location/camera/mic anywhere in this app (decision D6).
 */
import * as React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { ClerkProvider } from '@clerk/clerk-expo';
import { colors } from '@otoqa/mobile-core';
import { DispatchAuthProvider } from '../lib/convex';

import { CLERK_PUBLISHABLE_KEY } from '../lib/env';

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

export default function RootLayout() {
  return (
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
  );
}
