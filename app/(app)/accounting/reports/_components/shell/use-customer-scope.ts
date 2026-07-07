'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FunctionReturnType } from 'convex/server';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { FilterChipValue } from '@/components/web';
import type { ResolvedRange } from './types';

/**
 * The single active customer from the FilterBar, or undefined. The actions/
 * queries accept one customerId, so this reads a single-selected customer.
 * Shared by every view so the "Customer" facet behaves identically everywhere.
 */
export function useCustomerFilter(filters: FilterChipValue[]): Id<'customers'> | undefined {
  return useMemo(() => {
    const f = filters.find((x) => x.propId === 'customer');
    return f && f.values.length === 1 ? (f.values[0] as Id<'customers'>) : undefined;
  }, [filters]);
}

export type CustomerContribution = FunctionReturnType<
  typeof api.accountingReports.getProfitabilityBreakdown
>['fleet'];

/**
 * Contribution for a single customer (revenue − directly-attributable driver +
 * carrier pay). Sourced from the profitability breakdown action so it matches
 * the Profitability view exactly. Returns undefined when no customer is scoped
 * or while loading. Fuel/DEF/overhead are fleet-level — excluded by design.
 */
export function useCustomerContribution(
  organizationId: string,
  range: ResolvedRange,
  customerId: Id<'customers'> | undefined,
): CustomerContribution | undefined {
  const run = useAction(api.accountingReports.getProfitabilityBreakdown);
  const [data, setData] = useState<CustomerContribution>();

  useEffect(() => {
    if (!customerId) {
      setData(undefined);
      return;
    }
    let cancelled = false;
    void run({
      workosOrgId: organizationId,
      dateRangeStart: range.start,
      dateRangeEnd: range.end,
      customerId,
    })
      .then((r) => !cancelled && setData(r.fleet))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [organizationId, range.start, range.end, customerId, run]);

  return data;
}
