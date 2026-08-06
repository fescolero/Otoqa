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
 */
export const recentAuditLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    return await ctx.db
      .query('platformAuditLog')
      .withIndex('by_time')
      .order('desc')
      .take(limit);
  },
});
