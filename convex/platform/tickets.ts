import { v, ConvexError } from 'convex/values';
import { query, mutation } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { getCallerOrgId } from '../lib/auth';

/**
 * Support tickets. Staff manage them from the console; end users file them
 * through `reportProblem` — the ONE function in convex/platform/ that is
 * deliberately NOT staff-gated (it must accept tenant web and mobile
 * callers). It writes a single bounded row from the caller's own identity
 * and reads nothing, so the exposure is strictly "authenticated users may
 * file tickets".
 */

const TITLE_MAX = 200;
const BODY_MAX = 4000;

export const reportProblem = mutation({
  args: {
    title: v.string(),
    body: v.optional(v.string()),
    appContext: v.optional(v.string()), // JSON string from the client
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError('Unauthenticated');

    const title = args.title.trim().slice(0, TITLE_MAX);
    if (!title) throw new ConvexError('Title is required');

    // Best-effort org attribution: WorkOS tokens carry the org claim;
    // Clerk mobile tokens don't — staff can attribute later from the
    // reporter fields.
    const orgId = await getCallerOrgId(ctx);

    const now = Date.now();
    await ctx.db.insert('supportTickets', {
      source: 'user_report',
      status: 'open',
      severity: 'normal',
      title,
      body: args.body?.slice(0, BODY_MAX),
      orgId: orgId ?? undefined,
      reporterSubject: identity.subject,
      reporterEmail: typeof identity.email === 'string' ? identity.email : undefined,
      appContext: args.appContext?.slice(0, 2000),
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const createTicket = mutation({
  args: {
    title: v.string(),
    body: v.optional(v.string()),
    severity: v.union(v.literal('low'), v.literal('normal'), v.literal('high'), v.literal('urgent')),
    orgId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const now = Date.now();
    await ctx.db.insert('supportTickets', {
      source: 'staff',
      status: 'open',
      severity: args.severity,
      title: args.title.trim().slice(0, TITLE_MAX),
      body: args.body?.slice(0, BODY_MAX),
      orgId: args.orgId,
      reporterEmail: staff.email,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const listTickets = query({
  args: {
    status: v.optional(
      v.union(v.literal('open'), v.literal('in_progress'), v.literal('resolved'), v.literal('closed')),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    if (args.status !== undefined) {
      const status = args.status;
      return await ctx.db
        .query('supportTickets')
        .withIndex('by_status_time', (q) => q.eq('status', status))
        .order('desc')
        .take(limit);
    }
    // No status filter: newest overall.
    const all = await ctx.db.query('supportTickets').order('desc').take(limit);
    return all;
  },
});

/**
 * Row counts per status, for the board's filter chips.
 *
 * Separate from listTickets because that query returns ONE status at a time —
 * the filtered list can never say how many rows the other filters hold, which
 * is exactly what makes a chip worth clicking or not.
 */
export const ticketStatusCounts = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const CAP = 500;
    const statuses = ['open', 'in_progress', 'resolved', 'closed'] as const;
    const rows = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query('supportTickets')
          .withIndex('by_status_time', (q) => q.eq('status', status))
          .take(CAP),
      ),
    );
    const counts = Object.fromEntries(statuses.map((s, i) => [s, rows[i].length])) as Record<
      (typeof statuses)[number],
      number
    >;
    return { ...counts, all: rows.reduce((sum, r) => sum + r.length, 0) };
  },
});

export const updateTicket = mutation({
  args: {
    id: v.id('supportTickets'),
    status: v.optional(
      v.union(v.literal('open'), v.literal('in_progress'), v.literal('resolved'), v.literal('closed')),
    ),
    severity: v.optional(
      v.union(v.literal('low'), v.literal('normal'), v.literal('high'), v.literal('urgent')),
    ),
    assignToMe: v.optional(v.boolean()),
    resolutionNote: v.optional(v.string()),
    githubUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const ticket = await ctx.db.get(args.id);
    if (!ticket) throw new ConvexError('Ticket not found');
    await ctx.db.patch(args.id, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.severity !== undefined ? { severity: args.severity } : {}),
      ...(args.assignToMe ? { assignee: staff.email } : {}),
      ...(args.resolutionNote !== undefined
        ? { resolutionNote: args.resolutionNote.slice(0, BODY_MAX) }
        : {}),
      ...(args.githubUrl !== undefined ? { githubUrl: args.githubUrl } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});
