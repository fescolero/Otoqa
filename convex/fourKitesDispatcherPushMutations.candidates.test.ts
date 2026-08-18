/**
 * listFourKitesPushCandidates — the first read of every FourKites push tick.
 *
 * This query used to look the companion fourKitesPushState cursor up once
 * per candidate load, awaited in series inside the loop. That is one
 * database operation per In Transit / Pending load, so past a few hundred
 * active loads the query exhausted Convex's system-operation budget and
 * threw "Your request timed out performing too many system operations" —
 * killing the 60s cron before a single ping was pushed. It now reads the
 * org's cursor rows once over the by_org index and joins by loadId in
 * memory.
 *
 * These tests pin the observable contract that refactor had to preserve:
 * which loads qualify, that each one carries its OWN cursor, that cursors
 * from other orgs never bleed in, and that a duplicate cursor resolves to
 * the same row the old `.first()` returned.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_workos_fk_push';
const OTHER_ORG = 'org_workos_fk_push_other';

// Fixed epoch so cursor ordering is deterministic (2026-08-17T00:00:00Z).
const T0 = Date.UTC(2026, 7, 17);

type LoadOpts = {
  internalId: string;
  trackingStatus: 'Pending' | 'In Transit' | 'Completed' | 'Delayed' | 'Canceled';
  externalSource?: string;
  externalLoadId?: string;
  orderNumber?: string;
  workosOrgId?: string;
};

async function mkCustomer(ctx: MutationCtx, workosOrgId = ORG): Promise<Id<'customers'>> {
  return ctx.db.insert('customers', {
    name: 'FK Shipper',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 St',
    city: 'Oakland',
    state: 'California',
    zip: '94601',
    country: 'USA',
    workosOrgId,
    createdBy: 'u',
    createdAt: T0,
    updatedAt: T0,
  });
}

async function mkLoad(ctx: MutationCtx, opts: LoadOpts): Promise<Id<'loadInformation'>> {
  const workosOrgId = opts.workosOrgId ?? ORG;
  return ctx.db.insert('loadInformation', {
    internalId: opts.internalId,
    orderNumber: opts.orderNumber ?? `ORD-${opts.internalId}`,
    status: 'Assigned',
    trackingStatus: opts.trackingStatus,
    customerId: await mkCustomer(ctx, workosOrgId),
    customerName: 'FK Shipper',
    fleet: 'Main',
    units: 'Pallets',
    externalSource: opts.externalSource,
    externalLoadId: opts.externalLoadId,
    workosOrgId,
    createdBy: 'u',
    createdAt: T0,
    updatedAt: T0,
  });
}

async function mkPushState(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  lastPushedRecordedAt: number,
  workosOrgId = ORG,
): Promise<Id<'fourKitesPushState'>> {
  return ctx.db.insert('fourKitesPushState', {
    loadId,
    workosOrgId,
    lastPushedAt: lastPushedRecordedAt,
    lastPushedRecordedAt,
    updatedAt: lastPushedRecordedAt,
  });
}

describe('listFourKitesPushCandidates', () => {
  it('returns FK-sourced In Transit and Pending loads, and nothing else', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await mkLoad(ctx, {
        internalId: 'L-transit',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-1',
      });
      await mkLoad(ctx, {
        internalId: 'L-pending',
        trackingStatus: 'Pending',
        externalSource: 'FOURKITES',
        externalLoadId: 'FK-2',
      });
      // Wrong tracking status — the push only covers active shipments.
      await mkLoad(ctx, {
        internalId: 'L-done',
        trackingStatus: 'Completed',
        externalSource: 'FourKites',
        externalLoadId: 'FK-3',
      });
      // Not FK-sourced: no Dispatcher identifier to push against.
      await mkLoad(ctx, {
        internalId: 'L-manual',
        trackingStatus: 'In Transit',
        externalLoadId: 'FK-4',
      });
      // FK-sourced but no externalLoadId — identifierKeys would be empty.
      await mkLoad(ctx, {
        internalId: 'L-noid',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
      });
      // Another org's FK load must not appear in this org's tick.
      await mkLoad(ctx, {
        internalId: 'L-otherorg',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-5',
        workosOrgId: OTHER_ORG,
      });
    });

    const candidates = await t.query(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: ORG },
    );

    expect(candidates.map((c) => c.internalId).sort()).toEqual(['L-pending', 'L-transit']);
    expect(candidates.map((c) => c.externalLoadId).sort()).toEqual(['FK-1', 'FK-2']);
  });

  it('joins each load to its own cursor and leaves uncursored loads undefined', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await mkLoad(ctx, {
        internalId: 'L-a',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-A',
      });
      const b = await mkLoad(ctx, {
        internalId: 'L-b',
        trackingStatus: 'Pending',
        externalSource: 'FourKites',
        externalLoadId: 'FK-B',
      });
      // L-c stays cursorless: never pushed before.
      await mkLoad(ctx, {
        internalId: 'L-c',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-C',
      });
      await mkPushState(ctx, a, T0 + 1_000);
      await mkPushState(ctx, b, T0 + 2_000);
    });

    const candidates = await t.query(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: ORG },
    );
    const byInternalId = new Map(candidates.map((c) => [c.internalId, c]));

    expect(byInternalId.get('L-a')?.lastPushedRecordedAt).toBe(T0 + 1_000);
    expect(byInternalId.get('L-b')?.lastPushedRecordedAt).toBe(T0 + 2_000);
    expect(byInternalId.get('L-c')?.lastPushedRecordedAt).toBeUndefined();
    expect(byInternalId.get('L-c')?.pushStateId).toBeUndefined();
    // The cursor id must be the row for THAT load — the dedup and the
    // subsequent patch in recordPushResults both key off it.
    expect(byInternalId.get('L-a')?.pushStateId).not.toBe(byInternalId.get('L-b')?.pushStateId);
  });

  it('ignores a cursor row belonging to another org', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const load = await mkLoad(ctx, {
        internalId: 'L-scoped',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-S',
      });
      // Cursor written under a different org than the load it points at.
      // This is the one place the org-scoped read differs from the old
      // per-load lookup, which ignored workosOrgId entirely. It cannot
      // arise from recordPushResults — that stamps the cursor with the
      // org whose tick produced the candidate — and the fallback if it
      // ever did is one redundant push, not a wrong one. Scoping the read
      // to the tenant is the behavior we want to keep.
      await mkPushState(ctx, load, T0 + 5_000, OTHER_ORG);
    });

    const candidates = await t.query(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: ORG },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].lastPushedRecordedAt).toBeUndefined();
  });

  it('resolves a duplicate cursor to the oldest row, as `.first()` did', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const load = await mkLoad(ctx, {
        internalId: 'L-dup',
        trackingStatus: 'In Transit',
        externalSource: 'FourKites',
        externalLoadId: 'FK-D',
      });
      // Two racing ticks each inserted a cursor for the same load. The
      // by_load index ordered these by _creationTime, so `.first()` took
      // the older one; the by_org join must agree.
      await mkPushState(ctx, load, T0 + 1_000);
      await mkPushState(ctx, load, T0 + 9_000);
    });

    const candidates = await t.query(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: ORG },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].lastPushedRecordedAt).toBe(T0 + 1_000);
  });

  it('returns every candidate at a load count that used to exhaust the op budget', async () => {
    const t = convexTest(schema);
    const COUNT = 250;
    await t.run(async (ctx) => {
      const customerId = await mkCustomer(ctx);
      for (let i = 0; i < COUNT; i++) {
        const loadId = await ctx.db.insert('loadInformation', {
          internalId: `L-${i}`,
          orderNumber: `ORD-${i}`,
          status: 'Assigned',
          trackingStatus: i % 2 === 0 ? 'In Transit' : 'Pending',
          customerId,
          customerName: 'FK Shipper',
          fleet: 'Main',
          units: 'Pallets',
          externalSource: 'FourKites',
          externalLoadId: `FK-${i}`,
          workosOrgId: ORG,
          createdBy: 'u',
          createdAt: T0,
          updatedAt: T0,
        });
        // Every other load carries a cursor, so the join is exercised on
        // both the hit and the miss path at scale.
        if (i % 2 === 0) await mkPushState(ctx, loadId, T0 + i);
      }
    });

    const candidates = await t.query(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: ORG },
    );

    expect(candidates).toHaveLength(COUNT);
    const withCursor = candidates.filter((c) => c.lastPushedRecordedAt !== undefined);
    expect(withCursor).toHaveLength(COUNT / 2);
    // Each cursor landed on its own load rather than being smeared across
    // the batch by the in-memory join.
    for (const c of withCursor) {
      const i = Number(c.internalId.slice('L-'.length));
      expect(c.lastPushedRecordedAt).toBe(T0 + i);
    }
  });
});
