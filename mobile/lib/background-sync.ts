import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { processQueue, getPendingCount } from './offline-queue';

// ============================================
// BACKGROUND SYNC
// Process offline queue even when app is backgrounded
// ============================================

const BACKGROUND_SYNC_TASK = 'OTOQA_BACKGROUND_SYNC';

// Define the background task
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  const pendingCount = await getPendingCount();
  
  if (pendingCount === 0) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }

  try {
    await processQueue();
    const newPendingCount = await getPendingCount();
    
    if (newPendingCount < pendingCount) {
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.error('Background sync failed:', error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// Register the background task
export async function registerBackgroundSync() {
  try {
    // Check if task is already registered
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: 15 * 60, // 15 minutes (minimum on iOS)
        stopOnTerminate: false,
        startOnBoot: true,
      });
      console.log('Background sync task registered');
    }
  } catch (error) {
    console.error('Failed to register background sync:', error);
  }
}

// Unregister the background task
export async function unregisterBackgroundSync() {
  try {
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    console.log('Background sync task unregistered');
  } catch (error) {
    console.error('Failed to unregister background sync:', error);
  }
}

// Check background sync status
export async function getBackgroundSyncStatus() {
  const status = await BackgroundFetch.getStatusAsync();
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  
  return {
    status,
    isRegistered,
    statusLabel: getStatusLabel(status),
  };
}

function getStatusLabel(status: BackgroundFetch.BackgroundFetchStatus): string {
  switch (status) {
    case BackgroundFetch.BackgroundFetchStatus.Available:
      return 'Available';
    case BackgroundFetch.BackgroundFetchStatus.Denied:
      return 'Denied';
    case BackgroundFetch.BackgroundFetchStatus.Restricted:
      return 'Restricted';
    default:
      return 'Unknown';
  }
}

