import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

/**
 * Tests for tryClaimPollSlot — the atomic overlap guard for the every-10s
 * Samsara poll cron. Covers:
 *   1. First-claim path: empty syncState → claimed:true
 *   2. Immediate re-claim: another tick starts before previous finishes
 *      → claimed:false (the whole reason this exists)
 *   3. Reclaim after timeout: hung tick's lock falls open after 30s
 *      → claimed:true
 *   4. Reclaim after clean completion: lastPolledAt advanced past
 *      lastTickStartedAt → claimed:true
 */

const ORG = 'org_samsara_lock_test';
const USER_SUBJECT = 'user_samsara_lock_test';
const LOCK_TIMEOUT_MS = 30 * 1000;

async function seedSyncState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  patch: Partial<{
    lastTickStartedAt: number;
    lastPolledAt: number;
  }> = {},
): Promise<{ syncStateId: Id<'samsaraSyncState'> }> {
  const now = Date.now();

  const integrationId = await ctx.db.insert('orgIntegrations', {
    workosOrgId: ORG,
    provider: 'samsara',
    credentials: '{}',
    syncSettings: { isEnabled: true },
    lastSyncStats: {},
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });

  const syncStateId = await ctx.db.insert('samsaraSyncState', {
    integrationId,
    workosOrgId: ORG,
    ...patch,
    updatedAt: now,
  });

  return { syncStateId };
}

describe('samsaraIngestMutations.tryClaimPollSlot', () => {
  it('first claim on a fresh syncState row succeeds and stamps lastTickStartedAt', async () => {
    const t = convexTest(schema);

    const { syncStateId } = await t.run(async (ctx) => seedSyncState(ctx));

    const result = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );

    expect(result.claimed).toBe(true);

    const after = await t.run(async (ctx) => ctx.db.get(syncStateId));
    expect(after?.lastTickStartedAt).toBeTypeOf('number');
  });

  it('second claim while first is in-flight (within lock window) is rejected', async () => {
    const t = convexTest(schema);
    const { syncStateId } = await t.run(async (ctx) =>
      // Simulate a tick that started 1 second ago and hasn't finished
      // (lastPolledAt is undefined).
      seedSyncState(ctx, { lastTickStartedAt: Date.now() - 1000 }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );

    expect(result.claimed).toBe(false);
    if (result.claimed === false) {
      expect(result.reason).toMatch(/prev_tick_in_flight/);
    }
  });

  it('claim succeeds after lock timeout even if previous tick never recorded completion', async () => {
    const t = convexTest(schema);
    const { syncStateId } = await t.run(async (ctx) =>
      // Tick started 60s ago (> 30s LOCK_TIMEOUT_MS) and never finished —
      // presumed hung, lock falls open.
      seedSyncState(ctx, { lastTickStartedAt: Date.now() - 60_000 }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );

    expect(result.claimed).toBe(true);
  });

  it('claim succeeds when previous tick completed cleanly (lastPolledAt > lastTickStartedAt)', async () => {
    const t = convexTest(schema);
    const now = Date.now();
    const { syncStateId } = await t.run(async (ctx) =>
      seedSyncState(ctx, {
        lastTickStartedAt: now - 5_000,
        lastPolledAt: now - 3_000, // completed 3s ago
      }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );

    expect(result.claimed).toBe(true);
  });

  it('claim auto-succeeds when syncState row vanishes mid-cron (defensive path)', async () => {
    const t = convexTest(schema);
    const { syncStateId } = await t.run(async (ctx) => seedSyncState(ctx));

    await t.run(async (ctx) => ctx.db.delete(syncStateId));

    const result = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );

    // Caller will exit cleanly because context resolution returns null
    // upstream — but the claim itself should not throw.
    expect(result.claimed).toBe(true);
  });

  // Suppress the unused LOCK_TIMEOUT_MS reference (documentation only).
  void LOCK_TIMEOUT_MS;
});
