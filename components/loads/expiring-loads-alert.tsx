'use client';

import Link from 'next/link';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';

/**
 * Dispatcher warning surface for the auto-expiry grace period: assigned
 * loads whose pickup date passed with no tracking activity. They expire on
 * the next nightly sweep unless tracking starts or dates are updated.
 * Renders nothing when there are no warned loads.
 */
export function ExpiringLoadsAlert() {
  const loads = useAuthQuery(api.loads.getExpiryWarnedLoads, {});

  if (!loads || loads.length === 0) {
    return null;
  }

  return (
    <Card className="p-4 border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <h3 className="text-sm font-semibold">
          {loads.length} assigned load{loads.length === 1 ? '' : 's'} about to auto-expire
        </h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Pickup date passed with no tracking activity. These expire on the next nightly sweep unless
        tracking starts or the dates are updated.
      </p>
      <div className="space-y-2">
        {loads.map((load) => (
          <Link
            key={load._id}
            href={`/loads/${load._id}`}
            className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted/50"
          >
            <span className="font-medium">
              {load.internalId}
              <span className="text-muted-foreground font-normal"> · {load.orderNumber}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              pickup {load.firstStopDate ?? 'unknown'} · warned{' '}
              {formatDistanceToNow(new Date(load.expiryWarnedAt), { addSuffix: true })}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
