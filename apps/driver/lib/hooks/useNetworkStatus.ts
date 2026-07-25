import { useEffect, useRef, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { trackConnectionQualityChange } from '../analytics';

// ============================================
// NETWORK STATUS HOOK
// Exposes connection quality: 'good' | 'poor' | 'offline'
// ============================================

export type ConnectionQuality = 'good' | 'poor' | 'offline';

function deriveConnectionQuality(state: NetInfoState | null): ConnectionQuality {
  if (!state || state.isConnected === false || state.isConnected === null) {
    return 'offline';
  }

  const isReachable = state.isInternetReachable;

  const cellGen =
    state.type === 'cellular' && state.details
      ? state.details.cellularGeneration
      : null;

  const isPoor =
    isReachable === false ||
    isReachable === null ||
    cellGen === '2g' ||
    cellGen === '3g';

  return isPoor ? 'poor' : 'good';
}

function getCellularGeneration(state: NetInfoState | null): string | null {
  if (state?.type === 'cellular' && state.details) {
    return state.details.cellularGeneration ?? null;
  }
  return null;
}

export function useNetworkStatus() {
  const [state, setState] = useState<NetInfoState | null>(null);
  const prevQualityRef = useRef<ConnectionQuality | null>(null);

  useEffect(() => {
    NetInfo.fetch().then(setState);
    const unsubscribe = NetInfo.addEventListener(setState);
    return () => unsubscribe();
  }, []);

  const isConnected = state?.isConnected ?? null;
  const connectionQuality = deriveConnectionQuality(state);

  // Track quality transitions (skip initial null -> first value)
  useEffect(() => {
    if (prevQualityRef.current !== null && prevQualityRef.current !== connectionQuality) {
      trackConnectionQualityChange(connectionQuality, {
        connectionType: state?.type ?? null,
        cellularGeneration: getCellularGeneration(state),
      });
    }
    prevQualityRef.current = connectionQuality;
  }, [connectionQuality, state]);

  return {
    isConnected,
    isOffline: isConnected === false,
    connectionQuality,
    connectionType: state?.type ?? null,
  };
}

export function getConnectionQualityFromNetInfo(state: NetInfoState): ConnectionQuality {
  return deriveConnectionQuality(state);
}
