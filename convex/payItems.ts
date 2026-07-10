/**
 * payItems — public queries against the unified ledger.
 *
 * v1 surface: `listForLoad` returns every active (non-voided) payItem produced
 * for a load, grouped by payee → leg. The load-detail Pay Plan card consumes
 * this directly. Future query work (settlement workspace, accounting export)
 * lives in this file too.
 *
 * Append-only contract: voided rows are filtered out. Locked rows are surfaced
 * with an `isLocked: true` flag so the UI can render an edit-blocked treatment.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';
import type { Doc, Id } from './_generated/dataModel';

// ============================================================================
// QUERIES
// ============================================================================

/**
 * All payItems for one load, grouped by (payeeType, payeeId) then by leg.
 *
 * Returns:
 *   - `payees`: ordered list — carriers first, then drivers, then anyone with
 *     no leg attribution (rare: post-calc adjustments without a leg ref).
 *   - `totalCents`: signed grand total across all payees (number, not bigint,
 *     so it crosses the wire; cents fit in int53 for any realistic load).
 *   - `currency`: first non-empty currency seen across rows. Mixed-currency
 *     loads are rare in practice; UI can surface a warning.
 *   - `warnings`: aggregated `warning` strings from individual payItems.
 *   - `hasLockedItems`: whether any row is locked (UI shows recalc caveat).
 */
export const listForLoad = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, { loadId }) => {
    const { orgId } = await requireCallerIdentity(ctx);

    const load = await ctx.db.get(loadId);
    if (!load || load.workosOrgId !== orgId) {
      return {
        payees: [],
        totalCents: 0,
        currency: 'USD' as string,
        warnings: [] as Array<{ payItemId: string; message: string }>,
        hasLockedItems: false,
      };
    }

    // Pull all non-voided payItems for this load. The by_load_payee index
    // gives us (loadId, payeeType, payeeId) — already grouped.
    const allItems = await ctx.db
      .query('payItems')
      .withIndex('by_load_payee', q => q.eq('sourceRef.loadId', loadId))
      .collect();
    const items = allItems.filter(p => !p.isVoided);

    // Pull legs for this load — we need them for ordering + display data.
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', q => q.eq('loadId', loadId))
      .collect();
    legs.sort((a, b) => a.sequence - b.sequence);

    // ---- Resolve component, payee, and leg display data in parallel ----
    const componentIds = new Set(items.map(i => i.componentId));
    const componentMap = new Map<string, Doc<'chargeComponents'>>();
    for (const cid of componentIds) {
      const c = await ctx.db.get(cid);
      if (c) componentMap.set(c._id, c);
    }

    // Resolve leg display data (driver / truck / trailer names + stops).
    const legDisplay = new Map<string, LegDisplay>();
    for (const leg of legs) {
      const [driver, truck, trailer, startStop, endStop] = await Promise.all([
        leg.driverId ? ctx.db.get(leg.driverId) : null,
        leg.truckId ? ctx.db.get(leg.truckId) : null,
        leg.trailerId ? ctx.db.get(leg.trailerId) : null,
        ctx.db.get(leg.startStopId),
        ctx.db.get(leg.endStopId),
      ]);
      legDisplay.set(leg._id, {
        legId: leg._id,
        sequence: leg.sequence,
        driverId: leg.driverId ?? null,
        driverName: driver ? `${driver.firstName} ${driver.lastName}` : null,
        truckId: leg.truckId ?? null,
        truckUnitId: truck?.unitId ?? null,
        trailerId: leg.trailerId ?? null,
        trailerUnitId: trailer?.unitId ?? null,
        carrierPartnershipId: leg.carrierPartnershipId ?? null,
        startStopCity: startStop?.city,
        startStopState: startStop?.state,
        endStopCity: endStop?.city,
        endStopState: endStop?.state,
      });
    }

    // ---- Group items by payee, then by leg ----
    type ItemRow = (typeof items)[number] & {
      componentName: string;
      componentBucket: string;
      componentSign: 'CREDIT' | 'DEBIT';
      amountCentsNumber: number;        // wire-safe (bigint -> number)
      rateMicroCentsNumber: number;
    };
    type LegBucket = {
      legId: string | null;
      sequence: number;
      legDisplay: LegDisplay | null;
      items: ItemRow[];
      subtotalCents: number;
    };
    type PayeeBucket = {
      payeeType: 'DRIVER' | 'CARRIER';
      payeeId: string;
      payeeName: string;
      legs: LegBucket[];
      totalCents: number;
      hasLocked: boolean;
    };

    const payeeMap = new Map<string, PayeeBucket>();

    for (const item of items) {
      const component = componentMap.get(item.componentId);
      const enriched: ItemRow = {
        ...item,
        componentName: component?.displayName ?? item.description,
        componentBucket: component?.bucket ?? 'OTHER',
        componentSign: (component?.sign ?? 'CREDIT') as 'CREDIT' | 'DEBIT',
        amountCentsNumber: Number(item.amountCents),
        rateMicroCentsNumber: Number(item.rateMicroCents),
      };

      const payeeKey = `${item.payeeType}:${item.payeeId}`;
      let payeeBucket = payeeMap.get(payeeKey);
      if (!payeeBucket) {
        payeeBucket = {
          payeeType: item.payeeType as 'DRIVER' | 'CARRIER',
          payeeId: item.payeeId,
          payeeName: '',                 // resolved below
          legs: [],
          totalCents: 0,
          hasLocked: false,
        };
        payeeMap.set(payeeKey, payeeBucket);
      }

      // Find or create the leg bucket for this item
      const legId = item.sourceRef.legId ?? null;
      let legBucket = payeeBucket.legs.find(l => l.legId === legId);
      if (!legBucket) {
        const display = legId ? legDisplay.get(legId) ?? null : null;
        legBucket = {
          legId,
          sequence: display?.sequence ?? Number.MAX_SAFE_INTEGER,
          legDisplay: display,
          items: [],
          subtotalCents: 0,
        };
        payeeBucket.legs.push(legBucket);
      }

      legBucket.items.push(enriched);
      legBucket.subtotalCents += enriched.amountCentsNumber;
      payeeBucket.totalCents += enriched.amountCentsNumber;
      if (item.isLocked) payeeBucket.hasLocked = true;
    }

    // ---- Resolve payee names ----
    for (const bucket of payeeMap.values()) {
      if (bucket.payeeType === 'DRIVER') {
        const driver = await ctx.db.get(bucket.payeeId as Id<'drivers'>);
        bucket.payeeName = driver
          ? `${driver.firstName} ${driver.lastName}`
          : 'Unknown driver';
      } else {
        const carrier = await ctx.db.get(bucket.payeeId as Id<'carrierPartnerships'>);
        bucket.payeeName = carrier?.carrierName ?? 'Unknown carrier';
      }
      // Sort each payee's legs by sequence
      bucket.legs.sort((a, b) => a.sequence - b.sequence);
      // Sort items within a leg by created order (stable readback)
      for (const leg of bucket.legs) {
        leg.items.sort((a, b) => a.createdAt - b.createdAt);
      }
    }

    // ---- Order payees: carriers first, then drivers (alpha by name) ----
    const payees = Array.from(payeeMap.values()).sort((a, b) => {
      if (a.payeeType !== b.payeeType) return a.payeeType === 'CARRIER' ? -1 : 1;
      return a.payeeName.localeCompare(b.payeeName);
    });

    // ---- Aggregates ----
    const totalCents = payees.reduce((sum, p) => sum + p.totalCents, 0);
    const currency = items.find(i => i.currency)?.currency ?? 'USD';
    const warnings = items
      .filter(i => i.warning)
      .map(i => ({ payItemId: i._id as string, message: i.warning as string }));
    const hasLockedItems = payees.some(p => p.hasLocked);

    return {
      payees,
      totalCents,
      currency,
      warnings,
      hasLockedItems,
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Insert a manual adjustment payItem against a load. Used by the load-detail
 * "Pay adjustments" modal's "Add line item" preset chips.
 *
 * The caller picks a chargeComponent by `code` (resolved against the org's
 * catalog), names the line, and supplies an amount. We attach the resulting
 * payItem to the first leg of the load by default — that's where every
 * single-leg load wants its accessorials anyway, and multi-leg loads can
 * later be unassigned/reassigned via row-level edits (future work).
 *
 * Manual adjustments are NOT locked, so a future recalc won't void them
 * (the void targets EARNING / NEGOTIATED kinds only).
 */
export const addManualAdjustment = mutation({
  args: {
    loadId: v.id('loadInformation'),
    legId: v.optional(v.id('dispatchLegs')),
    payeeType: v.union(v.literal('DRIVER'), v.literal('CARRIER')),
    payeeId: v.string(),
    componentCode: v.string(),
    description: v.string(),
    amountCents: v.int64(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    // Ownership check on the load
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== orgId) {
      throw new Error('Load not found');
    }

    // Resolve componentCode → componentId in this org's catalog
    const component = await ctx.db
      .query('chargeComponents')
      .withIndex('by_org_code', q => q.eq('workosOrgId', orgId).eq('code', args.componentCode))
      .first();
    if (!component) {
      throw new Error(`Unknown charge component "${args.componentCode}" for this org`);
    }

    // Default leg attribution = first leg of the load
    let legId = args.legId;
    if (!legId) {
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', q => q.eq('loadId', args.loadId))
        .collect();
      legs.sort((a, b) => a.sequence - b.sequence);
      legId = legs[0]?._id;
    }

    // Currency = pull from any existing payItem on this load, else USD.
    const peer = await ctx.db
      .query('payItems')
      .withIndex('by_load_payee', q =>
        q.eq('sourceRef.loadId', args.loadId).eq('payeeType', args.payeeType).eq('payeeId', args.payeeId),
      )
      .first();
    const currency = peer?.currency ?? 'USD';

    const now = Date.now();
    const rateMicroCents = args.amountCents * BigInt(1_000); // qty=1 ⇒ rate = amount

    const payItemId = await ctx.db.insert('payItems', {
      workosOrgId: orgId,
      payeeType: args.payeeType,
      payeeId: args.payeeId,
      kind: 'MANUAL_ADJUSTMENT',
      componentId: component._id,
      lifecycleStatus: 'APPLIED',
      description: args.description,
      quantity: 1,
      rateMicroCents,
      amountCents: args.amountCents,
      currency,
      periodAnchorAt: now,
      sourceRef: {
        kind: 'MANUAL',
        loadId: args.loadId,
        legId: legId ?? undefined,
      },
      sourceData: {
        _variant: 'MANUAL_ADJUSTMENT',
        reason: args.reason ?? 'Manual adjustment',
      },
      isLocked: false,
      isVoided: false,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    });

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payItem',
      entityId: payItemId,
      entityName: args.description,
      action: 'added',
      description: `Added manual ${args.payeeType.toLowerCase()} pay line "${args.description}" (${formatCents(args.amountCents, currency)})`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return payItemId;
  },
});

/**
 * Update an existing manual-adjustment payItem's description and/or amount.
 *
 * Only `kind: 'MANUAL_ADJUSTMENT'` rows are editable through this path —
 * engine-produced EARNING/NEGOTIATED rows are immutable (a recalc voids and
 * replaces them). Voided rows can't be edited either.
 *
 * Because qty stays at 1 for manual lines, we update `rateMicroCents`
 * alongside `amountCents` so the row's math stays internally consistent
 * (qty × rate = amount).
 */
export const updateManualAdjustment = mutation({
  args: {
    payItemId: v.id('payItems'),
    description: v.optional(v.string()),
    amountCents: v.optional(v.int64()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const target = await ctx.db.get(args.payItemId);
    if (!target) throw new Error('Pay item not found');
    if (target.workosOrgId !== orgId) throw new Error('Pay item not found');

    if (target.isVoided) throw new Error('Pay item has been voided');
    if (target.kind !== 'MANUAL_ADJUSTMENT') {
      throw new Error('Only manual adjustments can be edited inline');
    }
    if (target.isLocked) throw new Error('Pay item is locked');

    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now, lastEditedBy: userId };
    const changedFields: string[] = [];

    if (args.description !== undefined && args.description !== target.description) {
      patch.description = args.description;
      changedFields.push('description');
    }
    if (args.amountCents !== undefined && args.amountCents !== target.amountCents) {
      patch.amountCents = args.amountCents;
      // Keep rate × qty = amount: qty stays 1, so rate (in micro-cents) =
      // amountCents * 1_000.
      patch.rateMicroCents = args.amountCents * BigInt(1_000);
      changedFields.push('amountCents');
    }
    if (changedFields.length === 0) return;

    await ctx.db.patch(args.payItemId, patch);

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payItem',
      entityId: args.payItemId,
      entityName: (patch.description as string | undefined) ?? target.description,
      action: 'updated',
      description: `Edited manual pay line "${(patch.description as string | undefined) ?? target.description}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      changedFields,
      timestamp: now,
    });
  },
});

/**
 * Void a manual-adjustment payItem. Append-only contract: we don't delete
 * the row, just mark it `isVoided: true` so it drops out of `listForLoad`
 * (and every other consumer that filters `isVoided=false`).
 *
 * Only `MANUAL_ADJUSTMENT` rows are voidable through this path — engine
 * rows are voided by recalc.
 */
export const voidManualAdjustment = mutation({
  args: {
    payItemId: v.id('payItems'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const target = await ctx.db.get(args.payItemId);
    if (!target) return;
    if (target.workosOrgId !== orgId) throw new Error('Pay item not found');

    if (target.isVoided) return;
    if (target.kind !== 'MANUAL_ADJUSTMENT') {
      throw new Error('Only manual adjustments can be removed inline');
    }
    if (target.isLocked) throw new Error('Pay item is locked');

    const now = Date.now();
    await ctx.db.patch(args.payItemId, {
      isVoided: true,
      voidedAt: now,
      voidReason: args.reason ?? 'Removed via load-detail pay editor',
      voidedByRunId: `manual-void:${userId}:${now}`,
      updatedAt: now,
      lastEditedBy: userId,
    });

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payItem',
      entityId: args.payItemId,
      entityName: target.description,
      action: 'voided',
      description: `Removed manual pay line "${target.description}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

// Helper: tiny in-file cents formatter for the audit log description.
// Avoids BigInt literals so the file targets the project's ts target.
const HUNDRED = BigInt(100);
const ZERO = BigInt(0);
function formatCents(cents: bigint, currency: string): string {
  const decimals = currency === 'MXN' ? 0 : 2;
  const negative = cents < ZERO;
  const abs = negative ? -cents : cents;
  const symbol = currency === 'CAD' ? 'CA$' : currency === 'MXN' ? 'MX$' : '$';
  const whole = abs / HUNDRED;
  const cs = abs % HUNDRED;
  if (decimals === 0) return `${negative ? '-' : ''}${symbol}${whole}`;
  return `${negative ? '-' : ''}${symbol}${whole}.${cs.toString().padStart(2, '0')}`;
}

// ============================================================================
// Internal types
// ============================================================================

type LegDisplay = {
  legId: Id<'dispatchLegs'>;
  sequence: number;
  driverId: Id<'drivers'> | null;
  driverName: string | null;
  truckId: Id<'trucks'> | null;
  truckUnitId: string | null;
  trailerId: Id<'trailers'> | null;
  trailerUnitId: string | null;
  carrierPartnershipId: Id<'carrierPartnerships'> | null;
  startStopCity?: string;
  startStopState?: string;
  endStopCity?: string;
  endStopState?: string;
};
