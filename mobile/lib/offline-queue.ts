import { queueStorage } from './storage';
import { v4 as uuidv4 } from 'uuid';
import NetInfo from '@react-native-community/netinfo';
import { getConnectionQualityFromNetInfo } from './hooks/useNetworkStatus';
// Using legacy API for SDK 54 compatibility
import * as FileSystem from 'expo-file-system/legacy';
import {
  trackOfflineQueueEnqueued,
  trackOfflineQueueProcessed,
  trackOfflineQueueItemSynced,
  trackOfflineQueueItemFailed,
} from './analytics';

// ============================================
// OFFLINE WRITE QUEUE
// Handles mutations when offline, syncs when online
// ============================================

export type MutationType =
  | 'checkIn'
  | 'checkOut'
  | 'statusUpdate'
  | 'recordPOD'
  | 'updateLocation';

export interface QueuedMutation {
  id: string;
  type: MutationType;
  payload: Record<string, unknown>;
  // Local file path for photos (in pending_uploads directory)
  photoPath?: string;
  // Timestamp when the action occurred (driver's device time)
  driverTimestamp: string;
  // When this was queued
  queuedAt: number;
  // Retry tracking
  retryCount: number;
  maxRetries: number;
  // Status
  status: 'pending' | 'processing' | 'failed' | 'completed';
  // Error message if failed
  errorMessage?: string;
}

const QUEUE_KEY = 'OFFLINE_MUTATION_QUEUE';
const PENDING_UPLOADS_DIR = `${FileSystem.documentDirectory}pending_uploads/`;

// Ensure pending uploads directory exists
async function ensurePendingUploadsDir() {
  const dirInfo = await FileSystem.getInfoAsync(PENDING_UPLOADS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(PENDING_UPLOADS_DIR, { intermediates: true });
  }
}

// Get all queued mutations
export async function getQueue(): Promise<QueuedMutation[]> {
  const data = await queueStorage.getString(QUEUE_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Save queue to storage
async function saveQueue(queue: QueuedMutation[]) {
  await queueStorage.set(QUEUE_KEY, JSON.stringify(queue));
}

// Add a mutation to the queue
export async function enqueueMutation(
  type: MutationType,
  payload: Record<string, unknown>,
  options?: {
    photoUri?: string; // Original photo URI (from camera)
  }
): Promise<string> {
  const id = uuidv4();
  const driverTimestamp = new Date().toISOString();

  let photoPath: string | undefined;

  // If there's a photo, move it to pending_uploads directory
  if (options?.photoUri) {
    await ensurePendingUploadsDir();
    const filename = `${id}_${Date.now()}.jpg`;
    photoPath = `${PENDING_UPLOADS_DIR}${filename}`;
    
    // Copy photo to pending uploads (safer than move)
    await FileSystem.copyAsync({
      from: options.photoUri,
      to: photoPath,
    });
  }

  const mutation: QueuedMutation = {
    id,
    type,
    payload: {
      ...payload,
      driverTimestamp, // Include driver timestamp in payload
    },
    photoPath,
    driverTimestamp,
    queuedAt: Date.now(),
    retryCount: 0,
    maxRetries: 5,
    status: 'pending',
  };

  const queue = await getQueue();
  queue.push(mutation);
  await saveQueue(queue);

  trackOfflineQueueEnqueued(type, {
    stopId: typeof payload.stopId === 'string' ? payload.stopId : undefined,
    loadId: typeof payload.loadId === 'string' ? payload.loadId : undefined,
  });

  // Try to process immediately if connection is good
  const netInfo = await NetInfo.fetch();
  if (getConnectionQualityFromNetInfo(netInfo) === 'good') {
    processQueue().catch(console.error);
  }

  return id;
}

// Update a mutation in the queue
export async function updateMutation(id: string, updates: Partial<QueuedMutation>) {
  const queue = await getQueue();
  const index = queue.findIndex((m) => m.id === id);
  if (index !== -1) {
    queue[index] = { ...queue[index], ...updates };
    await saveQueue(queue);
  }
}

// Remove a mutation from the queue
export async function removeMutation(id: string) {
  const queue = await getQueue();
  const filtered = queue.filter((m) => m.id !== id);
  await saveQueue(filtered);
}

// Get count of pending mutations
export async function getPendingCount(): Promise<number> {
  const queue = await getQueue();
  return queue.filter((m) => m.status === 'pending' || m.status === 'failed').length;
}

// Delete local photo after successful upload
async function deleteLocalPhoto(photoPath: string) {
  try {
    const fileInfo = await FileSystem.getInfoAsync(photoPath);
    if (fileInfo.exists) {
      await FileSystem.deleteAsync(photoPath);
    }
  } catch (error) {
    console.error('Failed to delete local photo:', error);
  }
}

// Process the queue (called when online)
let isProcessing = false;

export async function processQueue(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) return;
  isProcessing = true;

  try {
    const netInfo = await NetInfo.fetch();
    if (getConnectionQualityFromNetInfo(netInfo) !== 'good') {
      return;
    }

    const queue = await getQueue();
    const pendingMutations = queue.filter(
      (m) => m.status === 'pending' || (m.status === 'failed' && m.retryCount < m.maxRetries)
    );

    if (pendingMutations.length === 0) return;

    const batchStart = Date.now();
    let succeeded = 0;
    let failed = 0;

    for (const mutation of pendingMutations) {
      try {
        await updateMutation(mutation.id, { status: 'processing' });

        // Process the mutation based on type
        await processMutation(mutation);

        // Success - remove from queue and delete local photo
        if (mutation.photoPath) {
          await deleteLocalPhoto(mutation.photoPath);
        }
        await removeMutation(mutation.id);
        succeeded++;
        trackOfflineQueueItemSynced(mutation.type, {
          retryCount: mutation.retryCount,
          queuedAgeMs: Date.now() - mutation.queuedAt,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await updateMutation(mutation.id, {
          status: 'failed',
          retryCount: mutation.retryCount + 1,
          errorMessage,
        });
        failed++;
        trackOfflineQueueItemFailed(mutation.type, {
          retryCount: mutation.retryCount + 1,
          error: errorMessage,
        });
      }
    }

    trackOfflineQueueProcessed({
      total: pendingMutations.length,
      succeeded,
      failed,
      elapsed_ms: Date.now() - batchStart,
    });
  } finally {
    isProcessing = false;
  }
}

// Process a single mutation
async function processMutation(mutation: QueuedMutation): Promise<void> {
  // This will be implemented with actual Convex calls
  // For now, throw to indicate it needs implementation
  console.log('Processing mutation:', mutation.type, mutation.payload);
  
  // The actual implementation will be injected from the app
  // via setMutationProcessor
  if (mutationProcessor) {
    await mutationProcessor(mutation);
  } else {
    throw new Error('Mutation processor not set');
  }
}

// Allow the app to inject the mutation processor (with Convex client)
type MutationProcessor = (mutation: QueuedMutation) => Promise<void>;
let mutationProcessor: MutationProcessor | null = null;

export function setMutationProcessor(processor: MutationProcessor) {
  mutationProcessor = processor;
}

// Set up network listener to process queue when connection quality becomes good
export function setupNetworkListener() {
  return NetInfo.addEventListener((state) => {
    if (getConnectionQualityFromNetInfo(state) === 'good') {
      processQueue().catch(console.error);
    }
  });
}
