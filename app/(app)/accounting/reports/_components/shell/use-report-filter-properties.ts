'use client';

import { useMemo } from 'react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import type { FilterProperty } from '@/components/web';

/**
 * Builds the FilterBar property set for the Reports shell. Customer is a
 * lightweight facet (customers.list, caller-org scoped) and scopes the
 * record-level views (A/R aging, Discrepancies, Profitability). A previous
 * "Invoice status" facet was removed because no view consumed it — re-add it
 * here once it's wired to a query. Driver / carrier / lane facets land with
 * their views.
 */
export function useReportFilterProperties(): FilterProperty[] {
  const customers = useAuthQuery(api.customers.list, {});

  return useMemo<FilterProperty[]>(() => {
    const customerOptions = ((customers ?? []) as { _id: string; name?: string }[])
      .map((c) => ({ value: String(c._id), label: c.name ?? 'Unknown customer' }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return [{ id: 'customer', label: 'Customer', kind: 'enum', icon: 'briefcase', options: customerOptions }];
  }, [customers]);
}
