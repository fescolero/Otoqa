/**
 * Migration 010 — stamp the documents summaries on every driver and
 * partnership (documents-storage-spec.md §2, §6.3):
 *   drivers.missingDocTypeKeys / docExpirations / needsDateTypeKeys
 *   carrierPartnerships.missingDocTypeKeys + effective mirrors
 *
 * Until a driver row is stamped, list-row attention treats it as "every
 * required type missing" (the day-one rule), so run this right after the
 * deploy that introduces (or extends) the summary. Both backfills page and
 * schedule their own later pages — one command finishes the whole table,
 * and it is safe to re-run.
 *
 *   npx convex run migrations/010_backfill_document_summaries:runAll
 */

import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';

export const runAll = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.array(v.string()) }),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.entityDocuments.backfillDriverSummaries, {});
    await ctx.scheduler.runAfter(0, internal.entityDocuments.backfillPartnershipSummaries, {});
    return { scheduled: ['entityDocuments.backfillDriverSummaries', 'entityDocuments.backfillPartnershipSummaries'] };
  },
});
