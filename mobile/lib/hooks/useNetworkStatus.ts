import { useEffect, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

// ============================================
// NETWORK STATUS HOOK
// ============================================

export function useNetworkStatus() {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [connectionType, setConnectionType] = useState<string | null>(null);

  useEffect(() => {
    // Get initial state
    NetInfo.fetch().then((state) => {
      setIsConnected(state.isConnected);
      setConnectionType(state.type);
    });

    // Subscribe to changes
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      setIsConnected(state.isConnected);
      setConnectionType(state.type);
    });

    return () => unsubscribe();
  }, []);

  return {
    isConnected,
    isOffline: isConnected === false,
    connectionType,
  };
}

