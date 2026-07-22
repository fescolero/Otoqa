/**
 * Create-form drafts — Convex layer for Phase 4 of the create-form rollout.
 *
 * Storage shape: one row per (userId, entity, draftKey). The `vals` column is
 * JSON-stringified flat values from the form's `vals` map. Deliberately a
 * string (not a v.object validator) so future schema changes don't require a
 * Convex migration — the form layer parses on the way out.
 *
 * Lifecycle:
 *   - upsert: called every 800ms after the last edit by the page wrapper.
 *   - getByEntity: queried on the create page mount; populates the resume banner.
 *   - discard: called when the user clicks Discard on the banner OR after a
 *              successful Save (the form is now a real record, draft no
 *              longer needed).
 *   - listByUser: powers the (future) list-page draft indicator. Wired in
 *              the schema but no UI consumes it yet.
 *   - expireOld: internal mutation called by the nightly cron in
 *              `convex/crons.ts`. Deletes drafts older than 30 days, in
 *              batches of 500 so a single transaction never reads the
 *              full table.
 *
 * Auth: every mutation/query goes through `assertCallerOwnsOrg`. The userId
 * is taken from the caller identity, NOT from a user-supplied arg — so
 * tab A can't write a draft into tab B's userId by spoofing.
 *
 * See `docs/schema-evolution.md` for the policy on when to bump `draftKey`
 * (the answer is: any breaking schema change — renamed field, removed
 * field, changed enum value, changed field kind).
 */

import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { assertCallerOwnsOrg } from './lib/auth';

/* ────────────────────────────────────────────────────────────────────
 *  Public mutations + queries used by the page wrappers
 * ──────────────────────────────────────────────────────────────── */

/** Insert a new draft row OR patch the existing one for this
 *  (userId, entity, draftKey). Called every 800ms during active editing. */
export const upsert = mutation({
  args: {
    workosOrgId: v.string(),
    entity: v.string(),
    draftKey: v.string(),
    vals: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const existing = await ctx.db
      .query('createDrafts')
      .withIndex('by_user_entity', (q) =>
        q
          .eq('userId', userId)
          .eq('entity', args.entity)
          .eq('draftKey', args.draftKey),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { vals: args.vals, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert('createDrafts', {
      workosOrgId: args.workosOrgId,
      userId,
      entity: args.entity,
      draftKey: args.draftKey,
      vals: args.vals,
      updatedAt: now,
    });
  },
});

/** Delete the draft for this (userId, entity, draftKey). Idempotent —
 *  no-op if the row doesn't exist. Called on Discard click or after a
 *  successful Save. */
export const discard = mutation({
  args: {
    workosOrgId: v.string(),
    entity: v.string(),
    draftKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const existing = await ctx.db
      .query('createDrafts')
      .withIndex('by_user_entity', (q) =>
        q
          .eq('userId', userId)
          .eq('entity', args.entity)
          .eq('draftKey', args.draftKey),
      )
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/** Return the user's draft for this (entity, draftKey) or null. Reactive
 *  — the page wrapper's `useAuthQuery` re-fires when upsert/discard
 *  mutates the row, so the banner appears/disappears in real time. */
export const getByEntity = query({
  args: {
    workosOrgId: v.string(),
    entity: v.string(),
    draftKey: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      vals: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const draft = await ctx.db
      .query('createDrafts')
      .withIndex('by_user_entity', (q) =>
        q
          .eq('userId', userId)
          .eq('entity', args.entity)
          .eq('draftKey', args.draftKey),
      )
      .first();
    if (!draft) return null;
    return { vals: draft.vals, updatedAt: draft.updatedAt };
  },
});

/** Every draft the calling user has, across all entities. Not wired to
 *  any UI yet — reserved for a future list-page banner that says
 *  "3 unsaved drafts · review". Kept in the public API now so the
 *  shape is locked. */
export const listByUser = query({
  args: { workosOrgId: v.string() },
  returns: v.array(
    v.object({
      entity: v.string(),
      draftKey: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const rows = await ctx.db
      .query('createDrafts')
      .withIndex('by_org_user', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('userId', userId),
      )
      .collect();
    return rows.map((r) => ({
      entity: r.entity,
      draftKey: r.draftKey,
      updatedAt: r.updatedAt,
    }));
  },
});

/* ────────────────────────────────────────────────────────────────────
 *  Cron — 30-day expiry
 *
 *  Iterates the `by_updatedAt` index for rows older than the cutoff.
 *  Batched to 500 deletes per call to stay well under Convex's
 *  per-transaction document limit. If a batch is full the cron will
 *  catch the remainder the next night — no rush.
 * ──────────────────────────────────────────────────────────────── */

const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const EXPIRY_BATCH = 500;

export const expireOld = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - EXPIRY_MS;
    const stale = await ctx.db
      .query('createDrafts')
      .withIndex('by_updatedAt', (q) => q.lt('updatedAt', cutoff))
      .take(EXPIRY_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});
