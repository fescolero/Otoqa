/**
 * Review disposition for fuel / DEF entries — see lib/fuelReview for
 * what the statuses mean and why a review silences the reports'
 * exception rules.
 */

import { ConvexError, v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';
import { REVIEW_LABELS, reviewStatusValidator } from './lib/fuelReview';

export const setReview = mutation({
  args: {
    type: v.union(v.literal('fuel'), v.literal('def')),
    entryId: v.string(),
    /** `null` clears the review and puts the entry back in the queue. */
    status: v.union(reviewStatusValidator, v.null()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const table = args.type === 'fuel' ? 'fuelEntries' : 'defEntries';
    const id = ctx.db.normalizeId(table, args.entryId);
    const entry = id ? await ctx.db.get(id) : null;
    if (!entry || entry.organizationId !== orgId) throw new ConvexError('Entry not found');

    const note = args.note?.trim() || undefined;
    const review = args.status === null
      ? undefined
      : { status: args.status, reviewedAt: Date.now(), reviewedBy: userId, reviewedByName: userName, note };

    await ctx.db.patch(entry._id, { review, updatedAt: Date.now() });

    await logAudit(ctx, {
      organizationId: orgId,
      entityType: args.type === 'fuel' ? 'fuelEntry' : 'defEntry',
      entityId: entry._id,
      action: 'status_changed',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: review ? `Marked ${REVIEW_LABELS[review.status]}` : 'Review cleared',
      changesBefore: JSON.stringify({ review: entry.review ?? null }),
      changesAfter: JSON.stringify({ review: review ?? null }),
      changedFields: ['review'],
    });
    return entry._id;
  },
});
