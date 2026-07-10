// Review-time edit layer for the NEW ledger (payItems).
//
// This is the cutover prerequisite (M5.2): legacy settlements carry reviewer
// corrections (auto-timeout hour fixes, break deductions) that the fresh shadow
// ledger lacks. It ports legacy driverSettlements.editPayableLine /
// revertPayableEdit / applyRulesAmount, but honors the append-only ledger:
//
//   • An edit does NOT mutate the row in place. It VOIDS the system row
//     (isVoided=true, supersededByPayItemId → replacement) and inserts a LOCKED
//     replacement carrying a `reviewerEdit` block. The pre-edit row survives
//     forever as the voided predecessor — full audit, no lost history.
//   • The locked replacement is respected by the session recalc, which is
//     edit-aware (see calculatePayForSession): a later recalc never voids a
//     locked edit and never inserts a duplicate over it (edit-wins). When the
//     engine WOULD compute a different amount, it stamps the drift onto the
//     edit (engineAmountCents/engineDivergedAt) so a reviewer can adopt it.
//
// Shift lines (sourceRef.sessionId set): pass overrideStartAt/overrideEndAt/
// breakMinutes and the paid hours derive from the corrected clock span minus
// break. Other earning lines: pass rate and/or quantity; amount recomputes as
// quantity × rate with the engine's exact rounding (multiplyRateByQuantity).
import { mutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { requireCallerIdentity } from '../lib/auth';
import {
  multiplyRateByQuantity,
  asMicroCents,
  negate,
  rawCents,
  rawMicroCents,
} from '../lib/money';
// Settlement states past which a line is finalized and must not be edited.
import { FINALIZED_SETTLEMENT_STATUSES as FINALIZED_STATES } from './schema';

/**
 * Paid hours for a shift = corrected clock span − break, floored at 0, rounded
 * to 0.01h. Pure so it can be unit-tested and reused. Mirrors legacy
 * `Math.max((end - start)/3_600_000 - break/60, 0)` then `+hours.toFixed(2)`.
 */
export function correctedShiftHours(
  startAt: number,
  endAt: number,
  breakMinutes: number,
): number {
  const hours = Math.max((endAt - startAt) / 3_600_000 - breakMinutes / 60, 0);
  return Math.round(hours * 100) / 100;
}

/** Throw if the pay item's settlement is finalized (can't edit after approval). */
async function assertNotFinalized(
  ctx: { db: { get: (id: Id<'settlements'>) => Promise<Doc<'settlements'> | null> } },
  settlementId: Id<'settlements'> | undefined,
): Promise<void> {
  if (!settlementId) return;
  const settlement = await ctx.db.get(settlementId);
  if (settlement && FINALIZED_STATES.has(settlement.status)) {
    throw new Error('Cannot edit a finalized settlement');
  }
}

/**
 * Reviewer edit. Voids the target pay item and inserts a locked replacement
 * with the corrected quantity/rate/amount. For shift lines, the override span
 * (start/end/break) drives the hours. Idempotent-friendly: editing an already
 * edited line preserves the FIRST-edit original snapshot.
 */
export const editPayItem = mutation({
  args: {
    payItemId: v.id('payItems'),
    // shift-hours correction (only applied when the item is a session/shift line)
    overrideStartAt: v.optional(v.number()),
    overrideEndAt: v.optional(v.number()),
    breakMinutes: v.optional(v.number()),
    // direct overrides (non-shift lines, or an explicit hours override)
    quantity: v.optional(v.number()),
    rateMicroCents: v.optional(v.int64()),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    payItemId: v.id('payItems'),
    quantity: v.number(),
    amountCents: v.int64(),
  }),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const item = await ctx.db.get(args.payItemId);
    if (!item || item.workosOrgId !== orgId) throw new Error('Pay item not found');
    if (item.isVoided) throw new Error('Cannot edit a voided pay item');
    await assertNotFinalized(ctx, item.settlementId);

    const now = Date.now();
    const rate = asMicroCents(args.rateMicroCents ?? item.rateMicroCents);

    // Shift line: derive paid hours from the corrected clock span − break.
    const isShift = item.sourceRef.sessionId != null;
    let quantity = args.quantity ?? item.quantity;
    let overrideStartAt = item.reviewerEdit?.overrideStartAt;
    let overrideEndAt = item.reviewerEdit?.overrideEndAt;
    let breakMinutes = item.reviewerEdit?.breakMinutes;
    if (
      isShift &&
      (args.overrideStartAt != null ||
        args.overrideEndAt != null ||
        args.breakMinutes != null ||
        args.quantity == null)
    ) {
      const session = await ctx.db.get(item.sourceRef.sessionId!);
      overrideStartAt =
        args.overrideStartAt ?? item.reviewerEdit?.overrideStartAt ?? session?.startedAt ?? now;
      overrideEndAt =
        args.overrideEndAt ?? item.reviewerEdit?.overrideEndAt ?? session?.endedAt ?? now;
      breakMinutes = args.breakMinutes ?? item.reviewerEdit?.breakMinutes ?? 0;
      quantity = correctedShiftHours(overrideStartAt, overrideEndAt, breakMinutes);
    }

    // Recompute amount with the engine's exact rounding; preserve the sign of
    // the component (earnings positive, deductions negative).
    const magnitude = multiplyRateByQuantity(rate, quantity);
    const signedAmount = item.amountCents < BigInt(0) ? negate(magnitude) : magnitude;

    // First-edit original snapshot survives across re-edits.
    const original = item.reviewerEdit
      ? {
          quantity: item.reviewerEdit.originalQuantity,
          rateMicroCents: item.reviewerEdit.originalRateMicroCents,
          amountCents: item.reviewerEdit.originalAmountCents,
        }
      : {
          quantity: item.quantity,
          rateMicroCents: item.rateMicroCents,
          amountCents: item.amountCents,
        };

    // Append-only: clone the immutable fields into a locked replacement.
    const { _id, _creationTime, reviewerEdit: _prevEdit, ...carry } = item;
    const newId = await ctx.db.insert('payItems', {
      ...carry,
      quantity,
      rateMicroCents: rawMicroCents(rate), // rate stays as-supplied
      amountCents: rawCents(signedAmount),
      isLocked: true,
      isVoided: false,
      voidedAt: undefined,
      voidReason: undefined,
      voidedByRunId: undefined,
      supersededByPayItemId: undefined,
      reviewerEdit: {
        editedAt: now,
        editedBy: userId,
        reason: args.reason ?? item.reviewerEdit?.reason,
        overrideStartAt,
        overrideEndAt,
        breakMinutes,
        supersedesPayItemId: item._id,
        originalQuantity: original.quantity,
        originalRateMicroCents: original.rateMicroCents,
        originalAmountCents: original.amountCents,
      },
      createdAt: item.createdAt,
      updatedAt: now,
      lastEditedBy: userId,
    });

    await ctx.db.patch(item._id, {
      isVoided: true,
      voidedAt: now,
      voidReason: 'reviewer-edited',
      supersededByPayItemId: newId,
      updatedAt: now,
    });

    return { payItemId: newId, quantity, amountCents: rawCents(signedAmount) };
  },
});

/**
 * Restore a reviewer-edited line to its ORIGINAL system snapshot (mirrors
 * legacy revertPayableEdit). Voids the edited row and inserts a fresh UNLOCKED
 * row at the first-edit values, returning it to the rules engine's control (the
 * next session recalc will void+replace it since it's unlocked).
 */
export const revertPayItemEdit = mutation({
  args: { payItemId: v.id('payItems') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const item = await ctx.db.get(args.payItemId);
    if (!item || item.workosOrgId !== orgId) throw new Error('Pay item not found');
    if (!item.reviewerEdit) return null; // nothing to revert
    if (item.isVoided) throw new Error('Cannot revert a voided pay item');
    await assertNotFinalized(ctx, item.settlementId);

    const now = Date.now();
    const edit = item.reviewerEdit;
    const { _id, _creationTime, reviewerEdit: _prevEdit, ...carry } = item;
    const newId = await ctx.db.insert('payItems', {
      ...carry,
      quantity: edit.originalQuantity,
      rateMicroCents: edit.originalRateMicroCents,
      amountCents: edit.originalAmountCents,
      isLocked: false, // rules own it again
      isVoided: false,
      voidedAt: undefined,
      voidReason: undefined,
      voidedByRunId: undefined,
      supersededByPayItemId: undefined,
      reviewerEdit: undefined,
      createdAt: item.createdAt,
      updatedAt: now,
      lastEditedBy: userId,
    });

    await ctx.db.patch(item._id, {
      isVoided: true,
      voidedAt: now,
      voidReason: 'reviewer-edit-reverted',
      supersededByPayItemId: newId,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Adopt the engine's current amount for a line that drifted from a reviewer
 * edit (reviewerEdit.engineAmountCents set — the "rules changed" flag). Mirrors
 * legacy applyRulesAmount. Voids the edited row and re-runs the session calc so
 * the fresh engine row is inserted under rules control — guaranteeing the
 * adopted value reflects the CURRENT rules, not a stale snapshot.
 */
export const adoptEnginePayItem = mutation({
  args: { payItemId: v.id('payItems') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const item = await ctx.db.get(args.payItemId);
    if (!item || item.workosOrgId !== orgId) throw new Error('Pay item not found');
    if (!item.reviewerEdit || item.reviewerEdit.engineAmountCents == null) return null;
    if (item.isVoided) throw new Error('Cannot adopt on a voided pay item');
    await assertNotFinalized(ctx, item.settlementId);

    const sessionId = item.sourceRef.sessionId;
    if (!sessionId) {
      // Non-session line: no session recalc path. Fall back to reverting the
      // edit (returns to rules control); the leg recalc will refresh it.
      throw new Error('adoptEnginePayItem is only supported for session/shift lines');
    }

    const now = Date.now();
    // Void the edit so the recalc sees no locked row and inserts fresh.
    await ctx.db.patch(item._id, {
      isVoided: true,
      voidedAt: now,
      voidReason: 'reviewer-edit-adopted-engine',
      updatedAt: now,
    });
    await ctx.runMutation(internal.payEngine.calculatePayForSession.calculatePayForSession, {
      sessionId,
      userId,
    });
    return null;
  },
});
