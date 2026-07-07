'use client';

import { CarriersList } from '@/components/carriers/carriers-list';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';

export default function CarriersPage() {
  const router = useRouter();
  const workosOrgId = useOrganizationId();

  return (
    <CarriersList
      workosOrgId={workosOrgId}
      onCreate={() => router.push('/operations/carriers/create')}
      onImport={() => console.log('Import CSV: not implemented yet')}
      onExport={() => console.log('Export CSV: not implemented yet')}
    />
  );
}
