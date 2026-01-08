'use client';

import { createContext, useContext, ReactNode, useMemo } from 'react';

interface OrganizationContextType {
  organizationId: string;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

export function OrganizationProvider({
  organizationId,
  children,
}: {
  organizationId: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ organizationId }), [organizationId]);
  
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganizationId() {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganizationId must be used within OrganizationProvider');
  }
  return context.organizationId;
}
