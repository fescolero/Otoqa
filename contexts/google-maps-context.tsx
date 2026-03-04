'use client';

import { createContext, useContext, useEffect, ReactNode, useMemo } from 'react';
import { setGoogleMapsApiKey } from '@/lib/googlePlaces';

interface GoogleMapsContextType {
  googleMapsApiKey: string | undefined;
}

const GoogleMapsContext = createContext<GoogleMapsContextType | undefined>(undefined);

export function GoogleMapsProvider({
  apiKey,
  children,
}: {
  apiKey: string | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ googleMapsApiKey: apiKey }), [apiKey]);

  useEffect(() => {
    setGoogleMapsApiKey(apiKey);
  }, [apiKey]);

  return (
    <GoogleMapsContext.Provider value={value}>
      {children}
    </GoogleMapsContext.Provider>
  );
}

export function useGoogleMapsKey(): string | undefined {
  const context = useContext(GoogleMapsContext);
  if (context === undefined) {
    throw new Error('useGoogleMapsKey must be used within GoogleMapsProvider');
  }
  return context.googleMapsApiKey;
}
