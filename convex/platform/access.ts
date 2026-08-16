import { v } from 'convex/values';
import { query, mutation } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';

/**
 * Platform console — access & bootstrap.
 *
 * EVERY exported function in convex/platform/ starts with
 * requirePlatformStaff(ctx) (fail-closed issuer + allowlist check; see
 * convex/lib/auth.ts). Tenant helpers (assertCallerOwnsOrg etc.) are never
 * used here, and cross-org reads/writes exist only in this namespace —
 * that's the isolation contract from docs/platform-admin-console-plan.md §4.
 */

/**
 * Who am I, as far as the console is concerned. The apps/admin shell calls
 * this on load: a successful answer renders the console; a ConvexError
 * renders the access-denied screen. Returning data (rather than a boolean)
 * keeps the check server-authoritative.
 */
export const me = query({
  args: {},
  returns: v.object({ email: v.string() }),
  handler: async (ctx) => {
    const staff = await requirePlatformStaff(ctx);
    return { email: staff.email };
  },
});

/**
 * Record a console session start in the platform audit log. Called once by
 * the shell after `me` succeeds — gives the audit trail a row for every
 * console access without logging each query.
 */
export const recordSessionStart = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const staff = await requirePlatformStaff(ctx);
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'staff_session_started',
    });
    return null;
  },
});

/**
 * Debug: the caller's OWN token claims as Convex sees them. Requires
 * authentication but deliberately NOT requirePlatformStaff — its purpose is
 * diagnosing why the staff gate rejected a session. Returns only the
 * caller's own claims (issuer/email/subject), never anyone else's data and
 * never any env/config values, so exposure is limited to what the caller's
 * own JWT already contains.
 */
export const debugIdentity = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return {
      issuer: identity.issuer,
      email: typeof identity.email === 'string' ? identity.email : null,
      emailVerified: typeof identity.emailVerified === 'boolean' ? identity.emailVerified : null,
      subject: identity.subject,
    };
  },
});

/**
 * Most recent platform-staff audit entries, newest first. Phase 0 surfaces
 * this on the console home so the very first feature is accountability.
 *
 * Filters are server-side and index-backed where possible: `targetOrgId` and
 * `actorEmail` each have their own index, and free-text search runs over a
 * bounded recent window (the log is append-only and time-ordered, so "recent"
 * is the only window that matters operationally).
 */
export const recentAuditLog = query({
  args: {
    limit: v.optional(v.number()),
    targetOrgId: v.optional(v.string()),
    actorEmail: v.optional(v.string()),
    action: v.optional(v.string()),
    search: v.optional(v.string()), // matches reason / target id / action
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

    // Pick the narrowest index the filters allow.
    const rows =
      args.targetOrgId !== undefined
        ? await ctx.db
            .query('platformAuditLog')
            .withIndex('by_target_org', (q) => q.eq('targetOrgId', args.targetOrgId))
            .order('desc')
            .take(limit * 4)
        : args.actorEmail !== undefined
          ? await ctx.db
              .query('platformAuditLog')
              .withIndex('by_actor', (q) => q.eq('actorEmail', args.actorEmail!))
              .order('desc')
              .take(limit * 4)
          : await ctx.db
              .query('platformAuditLog')
              .withIndex('by_time')
              .order('desc')
              .take(args.action !== undefined || args.search !== undefined ? 500 : limit);

    const needle = args.search?.trim().toLowerCase();
    return rows
      .filter((r) => args.action === undefined || r.action === args.action)
      .filter(
        (r) =>
          !needle ||
          r.reason?.toLowerCase().includes(needle) ||
          r.actorEmail.toLowerCase().includes(needle) ||
          r.action.toLowerCase().includes(needle) ||
          (r.targetId ?? '').toLowerCase().includes(needle) ||
          (r.targetOrgId ?? '').toLowerCase().includes(needle),
      )
      .slice(0, limit);
  },
});

/** Distinct actors seen in the log — powers the audit filter and, until an
 * access page exists, is the only in-console answer to "who has been here". */
export const auditActors = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const rows = await ctx.db.query('platformAuditLog').withIndex('by_time').order('desc').take(500);
    const byActor = new Map<string, { actorEmail: string; lastSeenAt: number; actions: number }>();
    for (const row of rows) {
      const existing = byActor.get(row.actorEmail);
      if (existing) {
        existing.actions++;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestamp);
      } else {
        byActor.set(row.actorEmail, {
          actorEmail: row.actorEmail,
          lastSeenAt: row.timestamp,
          actions: 1,
        });
      }
    }
    return [...byActor.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  },
});
