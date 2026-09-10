import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

/**
 * pollOneIntegration must release its poll claim even when the tick throws.
 *
 * The claim taken by tryClaimPollSlot is released by stamping `lastPolledAt`,
 * which only updateSyncStateAfterTick does. Before the release guard, a throw
 * anywhere between the claim and that call left `lastTickStartedAt` set with
 * no matching `lastPolledAt` — so tryClaimPollSlot reported the tick as still
 * in flight and rejected every claim until the 30s lock timeout, dropping
 * three 10s ticks of GPS per failure. Transient platform errors on the
 * runQuery / runAction / runMutation calls in the tick body make that a
 * routine occurrence, not a corner case.
 *
 * Here the throw is forced with a malformed encrypted token, which makes
 * samsaraCrypto.decryptSamsaraToken reject on the first await after the
 * claim — the same shape as the production failure.
 */

const ORG = 'org_samsara_release_test';
const USER_SUBJECT = 'user_samsara_release_test';

// Valid-length key so decryptSamsaraToken fails on the malformed *token*
// rather than on a missing key, whatever the ambient env holds.
const TEST_KEY = 'a'.repeat(64);

async function seedEnabledIntegration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: { apiTokenEncrypted: string },
): Promise<{
  integrationId: Id<'orgIntegrations'>;
  syncStateId: Id<'samsaraSyncState'>;
}> {
  const now = Date.now();

  const integrationId = await ctx.db.insert('orgIntegrations', {
    workosOrgId: ORG,
    provider: 'samsara',
    credentials: JSON.stringify({
      apiTokenEncrypted: opts.apiTokenEncrypted,
      environment: 'sandbox',
    }),
    syncSettings: { isEnabled: true },
    lastSyncStats: {},
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });

  const syncStateId = await ctx.db.insert('samsaraSyncState', {
    integrationId,
    workosOrgId: ORG,
    updatedAt: now,
  });

  return { integrationId, syncStateId };
}

describe('samsaraIngest.pollOneIntegration claim release', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('releases the claim and records the failure when the tick throws', async () => {
    vi.stubEnv('WEBHOOK_ENCRYPTION_KEY', TEST_KEY);
    const t = convexTest(schema);

    const { integrationId, syncStateId } = await t.run(async (ctx) =>
      seedEnabledIntegration(ctx, { apiTokenEncrypted: 'not-a-valid-token' }),
    );

    // The tick must still fail loudly — the release guard is not a catch-all.
    await expect(
      t.action(internal.samsaraIngest.pollOneIntegration, { integrationId }),
    ).rejects.toThrow();

    const state = await t.run(async (ctx) => ctx.db.get(syncStateId));
    expect(state?.lastTickStartedAt).toBeTypeOf('number');
    // Released: completion stamped after the start stamp.
    expect(state?.lastPolledAt).toBeTypeOf('number');
    expect(state!.lastPolledAt!).toBeGreaterThanOrEqual(state!.lastTickStartedAt!);
    expect(state?.lastErrorMessage).toMatch(/tick_threw/);
    expect(state?.lastErrorAt).toBeTypeOf('number');
  });

  it('lets the very next tick claim the slot after a throwing tick', async () => {
    vi.stubEnv('WEBHOOK_ENCRYPTION_KEY', TEST_KEY);
    const t = convexTest(schema);

    const { integrationId, syncStateId } = await t.run(async (ctx) =>
      seedEnabledIntegration(ctx, { apiTokenEncrypted: 'not-a-valid-token' }),
    );

    await expect(
      t.action(internal.samsaraIngest.pollOneIntegration, { integrationId }),
    ).rejects.toThrow();

    // Without the release this is `claimed: false` for the next 30s.
    const claim = await t.mutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId },
    );
    expect(claim.claimed).toBe(true);
  });

  it('leaves the poll cursor untouched when the tick throws before any page drains', async () => {
    vi.stubEnv('WEBHOOK_ENCRYPTION_KEY', TEST_KEY);
    const t = convexTest(schema);

    const { integrationId, syncStateId } = await t.run(async (ctx) => {
      const seeded = await seedEnabledIntegration(ctx, {
        apiTokenEncrypted: 'not-a-valid-token',
      });
      await ctx.db.patch(seeded.syncStateId, { pollCursor: 'cursor-abc' });
      return seeded;
    });

    await expect(
      t.action(internal.samsaraIngest.pollOneIntegration, { integrationId }),
    ).rejects.toThrow();

    // A failed tick must not advance or clear the cursor — the next tick has
    // to resume from exactly where this one started.
    const state = await t.run(async (ctx) => ctx.db.get(syncStateId));
    expect(state?.pollCursor).toBe('cursor-abc');
  });
});
