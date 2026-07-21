import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';

/**
 * Org member directory synced from WorkOS (the system of record for user
 * profiles). Convex stores no user names of its own, so this table is what
 * lets server-side queries resolve raw WorkOS user IDs to display names —
 * audit rows written before performer names were denormalized, and
 * record-level created-by/deleted-by fields, only carry the raw ID.
 *
 * Sync triggers (both push the full member list fetched from the WorkOS
 * API in `lib/sync-org-members.ts`):
 *  - login callback (app/callback/route.ts)
 *  - POST /api/organization/members/sync, fired once per tab by audit UIs
 *    that still encounter an unresolved ID (self-heal for sessions that
 *    predate this table)
 */

const MAX_MEMBERS_PER_SYNC = 2000;

export const syncMembers = mutation({
  args: {
    members: v.array(
      v.object({
        workosUserId: v.string(),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        email: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Org comes from the caller's identity — members can only be written
    // into the caller's own org. The name payload originates from the
    // WorkOS API on our server, but is display-only either way.
    const callerOrgId = await requireCallerOrgId(ctx);
    const members = args.members.slice(0, MAX_MEMBERS_PER_SYNC);
    const now = Date.now();

    for (const member of members) {
      const existing = await ctx.db
        .query('orgMembers')
        .withIndex('by_org_user', (q) => q.eq('organizationId', callerOrgId).eq('workosUserId', member.workosUserId))
        .unique();

      if (!existing) {
        await ctx.db.insert('orgMembers', {
          organizationId: callerOrgId,
          workosUserId: member.workosUserId,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          updatedAt: now,
        });
      } else if (
        existing.firstName !== member.firstName ||
        existing.lastName !== member.lastName ||
        existing.email !== member.email
      ) {
        await ctx.db.patch(existing._id, {
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          updatedAt: now,
        });
      }
    }
  },
});

/**
 * Look up display info for a set of WorkOS user IDs within an org.
 * Plain helper for use inside other queries (e.g. audit log enrichment).
 */
export async function getMemberDisplayMap(
  ctx: QueryCtx,
  organizationId: string,
  userIds: Iterable<string>,
): Promise<Map<string, { name?: string; email?: string }>> {
  const result = new Map<string, { name?: string; email?: string }>();
  for (const userId of new Set(userIds)) {
    const member = await ctx.db
      .query('orgMembers')
      .withIndex('by_org_user', (q) => q.eq('organizationId', organizationId).eq('workosUserId', userId))
      .unique();
    if (member) {
      const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
      result.set(userId, { name: name || undefined, email: member.email });
    }
  }
  return result;
}

// Resolve WorkOS user IDs to display names (caller's org only). Used by
// UIs that receive raw IDs from entity records (e.g. truck.createdBy).
export const resolveMemberNames = query({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const display = await getMemberDisplayMap(ctx, callerOrgId, args.userIds.slice(0, 50));
    const names: Record<string, string> = {};
    for (const [userId, info] of display) {
      const label = info.name || info.email;
      if (label) names[userId] = label;
    }
    return names;
  },
});

// Last audit-log action per member (caller's org only) — powers the
// "Last active" column on Settings → Team. Fresher than WorkOS
// lastSignInAt: any audited action counts as activity, not just sign-ins.
export const getLastActionTimes = query({
  args: { userIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const out: Record<string, number> = {};
    for (const userId of new Set(args.userIds.slice(0, 100))) {
      const last = await ctx.db
        .query('auditLog')
        .withIndex('by_user', (q) =>
          q.eq('organizationId', callerOrgId).eq('performedBy', userId),
        )
        .order('desc')
        .first();
      if (last) out[userId] = last.timestamp;
    }
    return out;
  },
});
