import { v } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Shared audit-trail writer.
 *
 * Every mutation that changes org data records what happened by calling
 * `logAudit(ctx, {...})`. The insert runs inside the caller's transaction —
 * do NOT route audit writes through `ctx.runMutation` (each runMutation is a
 * separate billed function invocation for the same result).
 *
 * `entityType` and `action` are closed unions so the audit trail stays
 * queryable: one spelling per concept. Extend the unions here when a new
 * entity or verb genuinely doesn't fit — never introduce a new casing of an
 * existing one (`CREATE` vs `created` split the history before).
 */

// Single source of truth for the audit vocabulary. The schema builds its
// v.union(v.literal(...)) validators from these arrays (convex/schema.ts),
// so a new value added here is enforced end-to-end: TS at call sites and
// document validation at the database.
export const AUDIT_ENTITY_TYPES = [
  'truck',
  'trailer',
  'driver',
  'driverProfileAssignment',
  'fuelVendor',
  'fuelEntry',
  'defEntry',
  'rateProfile',
  'rateRule',
  'loadPayable',
  'loadCarrierPayable',
  'carrierPartnership',
  'dispatchLeg',
  'load',
  'organization',
  'driverSettlement',
  'invoice',
  'loadCarrierAssignment',
  'customer',
  'payPlan',
  'contractLane',
  'routeAssignment',
  'recurringLoad',
  'integration',
  'carrierProfileAssignment',
] as const;

export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'deactivated',
  'reactivated',
  'restored',
  'terminated',
  'permanently_deleted',
  'unlocked',
  'bulk_created',
  'bulk_updated',
  'bulk_assigned',
  'voided',
  'set_default',
  'unset_default',
  'split',
  'driver_assigned',
  'driver_removed',
  'carrier_assigned',
  'resource_unassigned',
  'offered',
  'accepted',
  'declined',
  'awarded',
  'withdrawn',
  'cancelled',
  'started',
  'completed',
  'held',
  'released',
  'expired',
  'archived',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Shared validators for the schema and for query args that filter on these
// fields — one definition, enforced everywhere.
export const auditEntityTypeValidator = v.union(...AUDIT_ENTITY_TYPES.map((t) => v.literal(t)));
export const auditActionValidator = v.union(...AUDIT_ACTIONS.map((a) => v.literal(a)));

// Derived from the schema so a new auditLog column can't silently drift out
// of the write path; only the closed-union fields and the helper-supplied
// timestamp are overridden.
export type AuditEntry = Omit<WithoutSystemFields<Doc<'auditLog'>>, 'timestamp' | 'entityType' | 'action'> & {
  entityType: AuditEntityType;
  action: AuditAction;
};

export async function logAudit(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  await ctx.db.insert('auditLog', {
    ...entry,
    timestamp: Date.now(),
  });
}
