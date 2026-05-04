/**
 * Comments thread per record.
 *
 * One conceptual thread per (entityType, entityId) inside an org. Anyone
 * in the org can read and post; only the original author can edit or
 * delete their own comment.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';

export const listForRecord = query({
  args: { entityType: v.string(), entityId: v.string() },
  handler: async (ctx, { entityType, entityId }) => {
    const { orgId } = await requireCallerIdentity(ctx);
    const rows = await ctx.db
      .query('comments')
      .withIndex('by_entity', (q) =>
        q.eq('workosOrgId', orgId).eq('entityType', entityType).eq('entityId', entityId),
      )
      .collect();
    // Newest first.
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const addComment = mutation({
  args: {
    entityType: v.string(),
    entityId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const trimmed = args.body.trim();
    if (!trimmed) throw new Error('Empty comment');
    if (trimmed.length > 4000) throw new Error('Comment too long');

    return await ctx.db.insert('comments', {
      workosOrgId: orgId,
      entityType: args.entityType,
      entityId: args.entityId,
      body: trimmed,
      authorId: userId,
      authorName: userName ?? userEmail ?? 'Unknown',
      createdAt: Date.now(),
    });
  },
});

export const updateComment = mutation({
  args: { id: v.id('comments'), body: v.string() },
  handler: async (ctx, { id, body }) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const c = await ctx.db.get(id);
    if (!c) throw new Error('Comment not found');
    if (c.workosOrgId !== orgId) throw new Error('Not authorized for this comment');
    if (c.authorId !== userId) throw new Error('Only the author can edit a comment');
    const trimmed = body.trim();
    if (!trimmed) throw new Error('Empty comment');
    if (trimmed.length > 4000) throw new Error('Comment too long');
    await ctx.db.patch(id, { body: trimmed, editedAt: Date.now() });
  },
});

export const deleteComment = mutation({
  args: { id: v.id('comments') },
  handler: async (ctx, { id }) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const c = await ctx.db.get(id);
    if (!c) return;
    if (c.workosOrgId !== orgId) throw new Error('Not authorized for this comment');
    if (c.authorId !== userId) throw new Error('Only the author can delete a comment');
    await ctx.db.delete(id);
  },
});
