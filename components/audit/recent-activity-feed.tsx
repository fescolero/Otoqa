'use client';

import { useState } from 'react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, History } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface RecentActivityFeedProps {
  hours?: number;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  truck: 'Truck',
  trailer: 'Trailer',
  driver: 'Driver',
  driverProfileAssignment: 'Pay Profile',
  carrierProfileAssignment: 'Carrier Profile',
  fuelVendor: 'Fuel Vendor',
  fuelEntry: 'Fuel',
  defEntry: 'DEF',
  rateProfile: 'Rate Profile',
  rateRule: 'Rate Rule',
  loadPayable: 'Payable',
  loadCarrierPayable: 'Carrier Payable',
  carrierPartnership: 'Carrier',
  dispatchLeg: 'Dispatch',
  load: 'Load',
  LOAD: 'Load',
  organization: 'Organization',
  driverSettlement: 'Settlement',
  invoice: 'Invoice',
  loadCarrierAssignment: 'Carrier Assignment',
  customer: 'Customer',
  payPlan: 'Pay Plan',
  contractLane: 'Contract Lane',
  routeAssignment: 'Route',
  recurringLoad: 'Recurring Load',
  integration: 'Integration',
};

/**
 * Org-wide feed of recent audit activity for the dashboard, backed by
 * `api.auditLog.getRecentActivity` (org-scoped server-side, last N hours).
 */
export function RecentActivityFeed({ hours = 24 }: RecentActivityFeedProps) {
  // Stable per mount so the query subscription isn't re-created every render.
  const [nowMs] = useState(() => Date.now());
  const logs = useAuthQuery(api.auditLog.getRecentActivity, { hours, nowMs });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Recent Activity</h3>
        <span className="text-xs text-muted-foreground">Last {hours}h</span>
      </div>

      {logs === undefined && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {logs !== undefined && logs.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <div className="text-center space-y-2">
            <History className="mx-auto h-8 w-8" />
            <p className="text-sm">No activity in the last {hours} hours</p>
          </div>
        </div>
      )}

      {logs !== undefined && logs.length > 0 && (
        <div className="space-y-3">
          {logs.map((log) => {
            const performer = log.performedByName || log.performedByEmail || log.performedBy;
            return (
              <div key={log._id} className="flex items-start gap-3 text-sm">
                <Badge variant="outline" className="shrink-0 mt-0.5">
                  {ENTITY_TYPE_LABELS[log.entityType] ?? log.entityType}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate">{log.description || `${log.action} ${log.entityName ?? ''}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(log.timestamp), { addSuffix: true })}
                    {performer ? ` · ${performer}` : ''}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
