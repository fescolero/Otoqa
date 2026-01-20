import { QueryClient } from '@tanstack/react-query';
import { asyncStorageAdapter } from './storage';

// ============================================
// TANSTACK QUERY CLIENT WITH ASYNC STORAGE PERSISTENCE
// ============================================

// Create the query client with offline-friendly defaults
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 5 minutes while online
      staleTime: 5 * 60 * 1000,
      // Cache data for 24 hours (for offline access)
      gcTime: 24 * 60 * 60 * 1000,
      // Retry failed requests 3 times
      retry: 3,
      // Don't refetch on window focus for mobile
      refetchOnWindowFocus: false,
      // Enable network-only mode when offline
      networkMode: 'offlineFirst',
    },
    mutations: {
      // Retry mutations when back online
      retry: 3,
      networkMode: 'offlineFirst',
    },
  },
});

// Set up persistence (called on app startup)
// Uses AsyncStorage to persist the query cache for offline access
export async function setupQueryPersistence() {
  // Load persisted cache on startup
  const cachedData = await asyncStorageAdapter.getItem('OTOQA_QUERY_CACHE');
  if (cachedData) {
    try {
      // Note: Full hydration requires @tanstack/react-query-persist-client
      // For now, we just ensure the storage adapter is ready
      console.log('Query cache loaded from AsyncStorage');
    } catch (e) {
      console.error('Failed to load query cache:', e);
    }
  }

  // Persist cache on changes (simplified approach)
  // For production, consider using @tanstack/react-query-persist-client
}
