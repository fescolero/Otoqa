import { useState, useEffect, useCallback } from 'react';
import { getPendingCount, processQueue, getQueue } from '../offline-queue';

// ============================================
// HOOK: OFFLINE QUEUE STATUS
// Provides pending count and queue management
// ============================================

export function useOfflineQueue() {
  const [pendingCount, setPendingCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // Update pending count periodically
  useEffect(() => {
    const updateCount = async () => {
      const count = await getPendingCount();
      setPendingCount(count);
    };

    // Initial load
    updateCount();

    // Update every 5 seconds
    const interval = setInterval(updateCount, 5000);
    return () => clearInterval(interval);
  }, []);

  // Process queue manually
  const processQueueNow = useCallback(async () => {
    setIsProcessing(true);
    try {
      await processQueue();
      const count = await getPendingCount();
      setPendingCount(count);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  // Get full queue
  const getFullQueue = useCallback(async () => {
    return await getQueue();
  }, []);

  return {
    pendingCount,
    isProcessing,
    processQueue: processQueueNow,
    getQueue: getFullQueue,
  };
}

