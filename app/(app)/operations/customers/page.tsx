'use client';

import { CustomersList } from '@/components/customers/customers-list';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';

export default function CustomersPage() {
  const router = useRouter();
  const workosOrgId = useOrganizationId();

  return (
    <CustomersList
      workosOrgId={workosOrgId}
      onCreate={() => router.push('/operations/customers/create')}
      onImport={() => console.log('Import CSV: not implemented yet')}
      onExport={() => console.log('Export CSV: not implemented yet')}
    />
  );
}
