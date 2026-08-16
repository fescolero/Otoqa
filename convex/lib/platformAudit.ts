import { ConvexError } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Platform-staff audit writer — the ONLY sanctioned write path into
 * `platformAuditLog`. Mirrors the tenant-side `lib/audit.ts` pattern: the
 * insert runs inside the caller's mutation transaction (never via
 * `ctx.runMutation`), and `action` is a closed union so the trail stays
 * queryable with one spelling per concept.
 *
 * Two rules the tenant log doesn't have:
 *   - Destructive actions (DESTRUCTIVE_ACTIONS below) refuse to log — and
 *     therefore refuse to happen, since callers log inside the same
 *     transaction — without a non-empty `reason`.
 *   - Sensitive READS are logged too (e.g. revealing driver PII), not just
 *     writes. See docs/platform-admin-console-plan.md §8.
 */

export type PlatformAuditAction =
  // Console access
  | 'staff_session_started'
  // Feature flags
  | 'flag_set_org'
  | 'flag_set_global'
  // Account support
  | 'session_force_ended'
  | 'clerk_resync_triggered'
  | 'identity_link_updated'
  | 'org_soft_deleted'
  | 'org_restored'
  | 'driver_phone_corrected'
  | 'webhook_deliveries_requeued'
  | 'cron_job_retired'
  // Billing
  | 'billing_config_changed'
  | 'contract_updated'
  | 'invoice_issued'
  | 'invoice_sent'
  | 'invoice_payment_recorded'
  | 'invoice_payment_reversed'
  | 'invoice_written_off'
  | 'invoice_manual_created'
  | 'invoice_voided'
  | 'invoice_adjustment_added'
  | 'credit_issued'
  | 'credit_voided'
  | 'usage_rebaselined'
  // Sensitive reads
  | 'sensitive_data_revealed';

/**
 * Actions that must carry a reason — the helper throws otherwise.
 *
 * Money-correcting actions are all here: a reversal, a write-off, or a credit
 * is someone deciding a number was wrong, and "why" is the only part of that
 * decision a future reader can't reconstruct from the ledger itself.
 */
const DESTRUCTIVE_ACTIONS: ReadonlySet<PlatformAuditAction> = new Set([
  'flag_set_global',
  'session_force_ended',
  'identity_link_updated',
  'org_soft_deleted',
  'driver_phone_corrected',
  'invoice_voided',
  'invoice_payment_reversed',
  'invoice_written_off',
  'credit_issued',
  'credit_voided',
  'usage_rebaselined',
  'sensitive_data_revealed',
]);

// Derived from the schema so a new platformAuditLog column can't silently
// drift out of the write path.
export type PlatformAuditEntry = Omit<
  WithoutSystemFields<Doc<'platformAuditLog'>>,
  'timestamp' | 'action'
> & {
  action: PlatformAuditAction;
};

export async function logPlatformAudit(
  ctx: MutationCtx,
  entry: PlatformAuditEntry,
): Promise<void> {
  if (DESTRUCTIVE_ACTIONS.has(entry.action) && !entry.reason?.trim()) {
    throw new ConvexError(`Platform action ${entry.action} requires a reason`);
  }
  await ctx.db.insert('platformAuditLog', {
    ...entry,
    timestamp: Date.now(),
  });
}
