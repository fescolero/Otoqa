'use client';

import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { format } from 'date-fns';
import { CheckCircle2, Edit, Trash2, RotateCcw, UserPlus, UserMinus, Loader2, History } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface EntityAuditTimelineProps {
  entityType: string;
  entityId: string;
  limit?: number;
}

// Rows written before action names were normalized use UPPER_CASE variants
// ('CREATE', 'ASSIGN_DRIVER', ...) — fold them into the canonical spelling.
const LEGACY_ACTION_MAP: Record<string, string> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  BULK_CREATE: 'bulk_created',
  ASSIGN_DRIVER: 'driver_assigned',
  ASSIGN_CARRIER: 'carrier_assigned',
  UNASSIGN_RESOURCE: 'resource_unassigned',
};

const ACTION_STYLES: Record<string, { icon: LucideIcon; bg: string; fg: string }> = {
  created: { icon: CheckCircle2, bg: 'bg-blue-100 dark:bg-blue-900', fg: 'text-blue-600 dark:text-blue-400' },
  bulk_created: { icon: CheckCircle2, bg: 'bg-blue-100 dark:bg-blue-900', fg: 'text-blue-600 dark:text-blue-400' },
  updated: { icon: Edit, bg: 'bg-green-100 dark:bg-green-900', fg: 'text-green-600 dark:text-green-400' },
  deleted: { icon: Trash2, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
  deactivated: { icon: Trash2, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
  terminated: { icon: Trash2, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
  permanently_deleted: { icon: Trash2, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
  restored: { icon: RotateCcw, bg: 'bg-amber-100 dark:bg-amber-900', fg: 'text-amber-600 dark:text-amber-400' },
  reactivated: { icon: RotateCcw, bg: 'bg-amber-100 dark:bg-amber-900', fg: 'text-amber-600 dark:text-amber-400' },
  driver_assigned: { icon: UserPlus, bg: 'bg-blue-100 dark:bg-blue-900', fg: 'text-blue-600 dark:text-blue-400' },
  carrier_assigned: { icon: UserPlus, bg: 'bg-blue-100 dark:bg-blue-900', fg: 'text-blue-600 dark:text-blue-400' },
  driver_removed: { icon: UserMinus, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
  resource_unassigned: { icon: UserMinus, bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' },
};

const DEFAULT_STYLE = { icon: History, bg: 'bg-muted', fg: 'text-muted-foreground' };

function actionLabel(action: string): string {
  const canonical = LEGACY_ACTION_MAP[action] ?? action;
  const words = canonical.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Change history for a single entity, read from the universal `auditLog`
 * table via `api.auditLog.getEntityAuditLog` (org-scoped server-side).
 */
export function EntityAuditTimeline({ entityType, entityId, limit }: EntityAuditTimelineProps) {
  const logs = useAuthQuery(api.auditLog.getEntityAuditLog, { entityType, entityId, limit });

  if (logs === undefined) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <div className="text-center space-y-2">
          <History className="mx-auto h-8 w-8" />
          <p className="text-sm">No activity recorded yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const canonical = LEGACY_ACTION_MAP[log.action] ?? log.action;
        const style = ACTION_STYLES[canonical] ?? DEFAULT_STYLE;
        const Icon = style.icon;
        const performer = log.performedByName || log.performedByEmail || log.performedBy;

        return (
          <div key={log._id} className="flex items-start gap-3">
            <div className={`rounded-full p-2 ${style.bg}`}>
              <Icon className={`h-4 w-4 ${style.fg}`} />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium">{actionLabel(log.action)}</p>
              {log.description && <p className="text-sm text-muted-foreground">{log.description}</p>}
              <p className="text-xs text-muted-foreground">
                {format(new Date(log.timestamp), 'MMM d, yyyy h:mm a')}
                {performer ? ` · ${performer}` : ''}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
