'use client';

import { api } from '@/convex/_generated/api';
import type { AuditAction, AuditEntityType } from '@/convex/lib/audit';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { format } from 'date-fns';
import { CheckCircle2, Edit, Trash2, RotateCcw, UserPlus, UserMinus, Loader2, History, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Facts from the entity's own record, shown only when the entity has no
 * audit rows at all (e.g. it was created before audit logging existed).
 */
interface RecordFallback {
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  deactivatedAt?: number;
  deactivatedBy?: string;
}

interface EntityAuditTimelineProps {
  entityType: AuditEntityType;
  entityId: string;
  limit?: number;
  recordFallback?: RecordFallback;
}

// Rows written before action names were normalized use legacy spellings.
// The auditLogMigration backfill rewrites them in place; this map is a
// display-time safety net for the window before that migration has run.
const LEGACY_ACTION_MAP: Record<string, AuditAction> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  BULK_CREATE: 'bulk_created',
  ASSIGN_DRIVER: 'driver_assigned',
  ASSIGN_CARRIER: 'carrier_assigned',
  UNASSIGN_RESOURCE: 'resource_unassigned',
  ACTIVATE: 'reactivated',
  DEACTIVATE: 'deactivated',
  activated: 'reactivated',
};

interface ActionStyle {
  icon: LucideIcon;
  bg: string;
  fg: string;
}

const BLUE = { bg: 'bg-blue-100 dark:bg-blue-900', fg: 'text-blue-600 dark:text-blue-400' };
const GREEN = { bg: 'bg-green-100 dark:bg-green-900', fg: 'text-green-600 dark:text-green-400' };
const RED = { bg: 'bg-red-100 dark:bg-red-900', fg: 'text-red-600 dark:text-red-400' };
const AMBER = { bg: 'bg-amber-100 dark:bg-amber-900', fg: 'text-amber-600 dark:text-amber-400' };

const ACTION_STYLES: Partial<Record<AuditAction, ActionStyle>> = {
  created: { icon: CheckCircle2, ...BLUE },
  bulk_created: { icon: CheckCircle2, ...BLUE },
  updated: { icon: Edit, ...GREEN },
  deleted: { icon: Trash2, ...RED },
  deactivated: { icon: Trash2, ...RED },
  terminated: { icon: Trash2, ...RED },
  permanently_deleted: { icon: Trash2, ...RED },
  restored: { icon: RotateCcw, ...AMBER },
  reactivated: { icon: RotateCcw, ...AMBER },
  driver_assigned: { icon: UserPlus, ...BLUE },
  carrier_assigned: { icon: UserPlus, ...BLUE },
  driver_removed: { icon: UserMinus, ...RED },
  resource_unassigned: { icon: UserMinus, ...RED },
  expired: { icon: Clock, ...AMBER },
};

const DEFAULT_STYLE: ActionStyle = { icon: History, bg: 'bg-muted', fg: 'text-muted-foreground' };

function actionLabel(canonical: string): string {
  const words = canonical.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function TimelineEntry({
  style,
  title,
  description,
  timestamp,
  performer,
}: {
  style: ActionStyle;
  title: string;
  description?: string;
  timestamp: number;
  performer?: string;
}) {
  const Icon = style.icon;
  return (
    <div className="flex items-start gap-3">
      <div className={`rounded-full p-2 ${style.bg}`}>
        <Icon className={`h-4 w-4 ${style.fg}`} />
      </div>
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <p className="text-xs text-muted-foreground">
          {format(new Date(timestamp), 'MMM d, yyyy h:mm a')}
          {performer ? ` · ${performer}` : ''}
        </p>
      </div>
    </div>
  );
}

/**
 * Change history for a single entity, read from the universal `auditLog`
 * table via `api.auditLog.getEntityAuditLog` (org-scoped server-side).
 * When the entity predates audit logging (no rows), falls back to the
 * record-level facts in `recordFallback` so the timeline is never blank
 * for entities that do carry created/updated timestamps.
 */
export function EntityAuditTimeline({ entityType, entityId, limit, recordFallback }: EntityAuditTimelineProps) {
  const logs = useAuthQuery(api.auditLog.getEntityAuditLog, { entityType, entityId, limit });

  if (logs === undefined) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (logs.length === 0) {
    if (recordFallback?.createdAt) {
      return (
        <div className="space-y-3">
          {recordFallback.deactivatedAt && (
            <TimelineEntry
              style={ACTION_STYLES.deactivated ?? DEFAULT_STYLE}
              title="Deactivated"
              timestamp={recordFallback.deactivatedAt}
              performer={recordFallback.deactivatedBy}
            />
          )}
          {recordFallback.updatedAt && recordFallback.updatedAt !== recordFallback.createdAt && (
            <TimelineEntry
              style={ACTION_STYLES.updated ?? DEFAULT_STYLE}
              title="Last updated"
              timestamp={recordFallback.updatedAt}
            />
          )}
          <TimelineEntry
            style={ACTION_STYLES.created ?? DEFAULT_STYLE}
            title="Created"
            timestamp={recordFallback.createdAt}
            performer={recordFallback.createdBy}
          />
        </div>
      );
    }
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
        const style = ACTION_STYLES[canonical as AuditAction] ?? DEFAULT_STYLE;
        const performer = log.performedByName || log.performedByEmail || log.performedBy;

        return (
          <TimelineEntry
            key={log._id}
            style={style}
            title={actionLabel(canonical)}
            description={log.description}
            timestamp={log.timestamp}
            performer={performer}
          />
        );
      })}
    </div>
  );
}
