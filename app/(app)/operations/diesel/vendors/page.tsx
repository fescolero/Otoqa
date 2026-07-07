'use client';

import { VendorsList } from '@/components/diesel/vendors-list';
import { useOrganizationId } from '@/contexts/organization-context';

export default function FuelVendorsPage() {
  const workosOrgId = useOrganizationId();
  return <VendorsList workosOrgId={workosOrgId} />;
}
