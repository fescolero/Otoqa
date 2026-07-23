// Forward-anchor roll-forward — shared period policy.
//
// A payItem whose periodAnchorAt falls inside a period whose settlement is
// already FINALIZED can never be aggregated (the aggregator skips locked
// statements) and would orphan: on no statement, shown nowhere, silently
// missing from pay. Whenever an item is WRITTEN late — a deferred leg item
// released after its period's statement was approved, session pay for a
// shift that ended after approval, or a dual-written manual line — its
// anchor must roll onto the payee's NEXT open period so the next
// aggregation attaches it there instead (the new-ledger equivalent of the
// legacy carry-over).
//
// Anchors in a non-finalized (or nonexistent) period pass through unchanged.

import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { FINALIZED_SETTLEMENT_STATUSES } from './schema';

export type AnchorResolution = { anchor: number; rolledForward: boolean };

/** Pure policy over an already-fetched settlement list. */
export function resolveForwardAnchorFrom(
  settlements: Array<Doc<'settlements'>>,
  naturalAnchor: number,
  now: number,
): AnchorResolution {
  const containing = settlements.find(
    (s) => naturalAnchor >= s.periodStart && naturalAnchor <= s.periodEnd,
  );
  if (!containing || !FINALIZED_SETTLEMENT_STATUSES.has(containing.status)) {
    return { anchor: naturalAnchor, rolledForward: false };
  }
  const nextOpen = settlements
    .filter((s) => !FINALIZED_SETTLEMENT_STATUSES.has(s.status) && s.periodStart > containing.periodStart)
    .sort((a, b) => a.periodStart - b.periodStart)[0];
  // No open period yet: anchor just past the finalized window (never inside it),
  // so the next generated open period picks it up rather than orphaning it.
  return {
    anchor: nextOpen ? nextOpen.periodStart : Math.max(now, containing.periodEnd + 1),
    rolledForward: true,
  };
}

/**
 * One settlements fetch per payee, then resolve any number of anchors —
 * the shape the per-payee calc loops need (many specs, one payee).
 */
export async function makeForwardAnchorResolver(
  ctx: MutationCtx,
  payeeType: 'DRIVER' | 'CARRIER',
  payeeId: string,
): Promise<(naturalAnchor: number, now: number) => AnchorResolution> {
  const settlements = await ctx.db
    .query('settlements')
    .withIndex('by_payee_period', (q) => q.eq('payeeType', payeeType).eq('payeeId', payeeId))
    .collect();
  return (naturalAnchor, now) => resolveForwardAnchorFrom(settlements, naturalAnchor, now);
}
