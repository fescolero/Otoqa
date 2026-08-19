import type { QueryCtx } from '../_generated/server';

/**
 * Who counts as OURS.
 *
 * `BROKER` and `BROKER_CARRIER` orgs are Otoqa's customers: they hold the
 * contract, they accrue metered usage, they get invoiced. A plain `CARRIER`
 * org is a carrier a broker onboarded — the broker's counterparty, on the
 * mobile app, billed by nobody here. Its name, drivers and load volume are the
 * BROKER'S client data.
 *
 * Shared by the organization directory and the Overview rollup so the two
 * cannot drift: a KPI counting orgs the directory refuses to list would be a
 * number nobody can reconcile against anything.
 */
const CLIENT_ORG_TYPES = new Set(['BROKER', 'BROKER_CARRIER']);

/**
 * The type field is the RULE, not the whole test. Two orgs are never excluded
 * whatever `orgType` says:
 *
 *  - One with **no type recorded**. Absent is not the same as `CARRIER`, and a
 *    missing type is a data gap staff need to see and fix rather than a reason
 *    to hide a row.
 *  - One we have **actually billed**. If an invoice exists against an org then
 *    it is a paying customer whatever its label, and a mistyped row must not
 *    take a live account off the board while its balance keeps showing up in
 *    aging.
 *
 * So this can only ever exclude an org that is BOTH typed `CARRIER` AND has
 * never been invoiced — exactly the population meant.
 */
export function isClientOrg(orgType: string | undefined, hasBeenInvoiced: boolean): boolean {
  if (orgType === undefined) return true;
  if (CLIENT_ORG_TYPES.has(orgType)) return true;
  return hasBeenInvoiced;
}

/**
 * WorkOS org ids we have ever raised an invoice against.
 *
 * Capped: an org invoiced monthly contributes ~12 rows a year, so this covers
 * a large book. A cap overrun can only make the filter stricter (an org whose
 * invoices fell outside the scan looks un-billed), never looser, so it fails
 * toward hiding rather than toward leaking.
 */
const INVOICE_SCAN = 2000;

export async function invoicedOrgIds(ctx: QueryCtx): Promise<Set<string>> {
  const rows = await ctx.db.query('platformInvoices').take(INVOICE_SCAN);
  return new Set(rows.map((r) => r.workosOrgId));
}

/** Convenience for a single org, where a full scan would be wasteful. */
export async function hasBeenInvoiced(
  ctx: QueryCtx,
  workosOrgId: string | undefined,
): Promise<boolean> {
  if (!workosOrgId) return false;
  const first = await ctx.db
    .query('platformInvoices')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId))
    .first();
  return first !== null;
}
