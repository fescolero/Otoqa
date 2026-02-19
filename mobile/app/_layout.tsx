// IMPORTANT: Polyfills must be imported FIRST
import '../lib/polyfills';

import React, { useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, ClerkLoaded } from '@clerk/clerk-expo';
import { ConvexProvider } from 'convex/react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Updates from 'expo-updates';
import { PostHogProvider, usePostHog } from 'posthog-react-native';
import { convex, ConvexAuthProvider } from '../lib/convex';
import { queryClient, setupQueryPersistence } from '../lib/query-client';
import { setupNetworkListener, processQueue, setMutationProcessor } from '../lib/offline-queue';
import { registerBackgroundSync } from '../lib/background-sync';
import { useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { QueuedMutation } from '../lib/offline-queue';
import { uploadPODPhoto } from '../lib/s3-upload';
import { LanguageProvider } from '../lib/LanguageContext';

// ============================================
// ERROR BOUNDARY
// Catches JS crashes and displays them instead of white screen
// ============================================

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={errorStyles.container}>
          <ScrollView contentContainerStyle={errorStyles.scroll}>
            <Text style={errorStyles.title}>App Crashed</Text>
            <Text style={errorStyles.message}>
              {this.state.error?.message || 'Unknown error'}
            </Text>
            <Text style={errorStyles.stack}>
              {this.state.error?.stack || ''}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const errorStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20, paddingTop: 60 },
  scroll: { paddingBottom: 40 },
  title: { color: '#ff6b6b', fontSize: 24, fontWeight: 'bold', marginBottom: 12 },
  message: { color: '#fff', fontSize: 16, marginBottom: 16 },
  stack: { color: '#888', fontSize: 12, fontFamily: 'monospace' },
});

// ============================================
// ROOT LAYOUT
// Sets up all providers and initializes offline sync
// ============================================

// Clerk publishable key
const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set');
}

// Secure token cache for Clerk
const tokenCache = {
  async getToken(key: string) {
    try {
      return SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      return SecureStore.setItemAsync(key, value);
    } catch {
      return;
    }
  },
};

// PostHog debug component
function PostHogDebug() {
  const posthog = usePostHog();
  
  useEffect(() => {
    if (posthog) {
      console.log('[PostHog] Client initialized:', !!posthog);
      // Capture a test event on app start
      posthog.capture('app_started', {
        timestamp: new Date().toISOString(),
        platform: 'react-native',
      });
      console.log('[PostHog] Captured app_started event');
      
      // Force flush events
      posthog.flush();
      console.log('[PostHog] Flushed events');
    } else {
      console.error('[PostHog] Client NOT initialized!');
    }
  }, [posthog]);
  
  return null;
}

// Inner component that has access to Convex hooks
function ConvexInitializer({ children }: { children: React.ReactNode }) {
  const checkInMutation = useMutation(api.driverMobile.checkInAtStop);
  const checkOutMutation = useMutation(api.driverMobile.checkOutFromStop);
  const updateStatusMutation = useMutation(api.driverMobile.updateStopStatus);
  const recordPODMutation = useMutation(api.driverMobile.recordPOD);
  const getUploadUrl = useAction(api.s3Upload.getPODUploadUrl);

  useEffect(() => {
    // Set up the mutation processor for the offline queue
    setMutationProcessor(async (mutation: QueuedMutation) => {
      const { type, payload, photoPath } = mutation;

      switch (type) {
        case 'checkIn':
          await checkInMutation(payload as any);
          break;

        case 'checkOut': {
          let podPhotoUrl: string | undefined;

          // If there's a photo, upload it first
          if (photoPath) {
            const { uploadUrl, fileUrl } = await getUploadUrl({
              loadId: String(payload.loadId || ''),
              stopId: String(payload.stopId || ''),
              filename: `pod_${Date.now()}.jpg`,
            });

            const uploadResult = await uploadPODPhoto(uploadUrl, photoPath);
            if (uploadResult.success) {
              podPhotoUrl = fileUrl;
            }
          }

          await checkOutMutation({
            ...(payload as any),
            podPhotoUrl,
          });
          break;
        }

        case 'statusUpdate':
          await updateStatusMutation(payload as any);
          break;

        case 'recordPOD': {
          if (photoPath) {
            const { uploadUrl, fileUrl } = await getUploadUrl({
              loadId: String(payload.loadId || ''),
              stopId: String(payload.stopId || ''),
              filename: `pod_${Date.now()}.jpg`,
            });

            const uploadResult = await uploadPODPhoto(uploadUrl, photoPath);
            if (uploadResult.success) {
              await recordPODMutation({
                ...(payload as any),
                photoUrl: fileUrl,
              });
            }
          }
          break;
        }

        default:
          console.warn('Unknown mutation type:', type);
      }
    });

    // Process any queued mutations on startup
    processQueue().catch(console.error);
  }, [checkInMutation, checkOutMutation, updateStatusMutation, recordPODMutation, getUploadUrl]);

  return <>{children}</>;
}

export default function RootLayout() {
  useEffect(() => {
    // Set up TanStack Query persistence
    setupQueryPersistence().catch(console.error);

    // Set up network listener for offline queue
    const unsubscribe = setupNetworkListener();

    // Register background sync task
    registerBackgroundSync();

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function checkForOTAUpdate() {
      if (__DEV__) return;
      try {
        if (!Updates.isEnabled) return;
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch (e) {
        console.log('OTA update check failed:', e);
      }
    }
    checkForOTAUpdate();
  }, []);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <LanguageProvider>
          <PostHogProvider 
            apiKey="phc_PZ3GNbNMNfasjq93uuEzrw9vQABLHfe4OFxm4H7Sg6X"
            options={{
              host: 'https://us.i.posthog.com',
              enableSessionReplay: true,
              sessionReplayConfig: {
                maskAllTextInputs: true,
                maskAllImages: true,
                captureLog: true,
                captureNetworkTelemetry: true,
                throttleDelayMs: 1000,
              },
              flushAt: 1,
              flushInterval: 1000,
            }}
          >
            <PostHogDebug />
            <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
              <ClerkLoaded>
                <ConvexProvider client={convex}>
                  <ConvexAuthProvider>
                    <QueryClientProvider client={queryClient}>
                      <ConvexInitializer>
                        <Stack
                          screenOptions={{
                            headerStyle: {
                              backgroundColor: '#1a1a2e',
                            },
                            headerTintColor: '#fff',
                            headerTitleStyle: {
                              fontWeight: 'bold',
                            },
                            contentStyle: {
                              backgroundColor: '#16213e',
                            },
                          }}
                        >
                          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                          <Stack.Screen name="(app)" options={{ headerShown: false }} />
                        </Stack>
                        <StatusBar style="light" />
                      </ConvexInitializer>
                    </QueryClientProvider>
                  </ConvexAuthProvider>
                </ConvexProvider>
              </ClerkLoaded>
            </ClerkProvider>
          </PostHogProvider>
          </LanguageProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

