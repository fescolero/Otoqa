/**
 * Tests for `queryByOrg`.
 *
 * Run against the real schema via convex-test so a regression in the
 * `(table -> index, field)` mapping fails fast — e.g. if someone renames
 * `by_org` to `by_organization` on a registered table without updating
 * the helper, these tests will hit a "no such index" error.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { queryByOrg } from '../queryByOrg';

const ORG_A = 'org_test_query_a';
const ORG_B = 'org_test_query_b';

describe('queryByOrg', () => {
  it('returns the row for organizationStats scoped to the caller org', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      const baseCounts = {
        loadCounts: { Open: 0, Assigned: 0, Completed: 0, Canceled: 0, Expired: 0 },
        invoiceCounts: {
          MISSING_DATA: 0,
          DRAFT: 0,
          BILLED: 0,
          PENDING_PAYMENT: 0,
          PAID: 0,
          VOID: 0,
        },
        updatedAt: now,
      };
      await ctx.db.insert('organizationStats', { workosOrgId: ORG_A, ...baseCounts });
      await ctx.db.insert('organizationStats', { workosOrgId: ORG_B, ...baseCounts });

      const a = await queryByOrg(ctx, 'organizationStats', ORG_A).first();
      const b = await queryByOrg(ctx, 'organizationStats', ORG_B).first();

      expect(a?.workosOrgId).toBe(ORG_A);
      expect(b?.workosOrgId).toBe(ORG_B);
    });
  });

  it('returns the row for accountingPeriodStats scoped to the caller org', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('accountingPeriodStats', {
        workosOrgId: ORG_A,
        periodKey: '2026-04',
        totalInvoiced: 1,
        totalCollected: 0,
        invoiceCount: 1,
        paidInvoiceCount: 0,
        updatedAt: now,
      });
      await ctx.db.insert('accountingPeriodStats', {
        workosOrgId: ORG_B,
        periodKey: '2026-04',
        totalInvoiced: 99,
        totalCollected: 0,
        invoiceCount: 1,
        paidInvoiceCount: 0,
        updatedAt: now,
      });

      const rows = await queryByOrg(ctx, 'accountingPeriodStats', ORG_A).collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].workosOrgId).toBe(ORG_A);
      expect(rows[0].totalInvoiced).toBe(1);
    });
  });

  it('isolates auditLog rows by org via the by_organization index', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const base = {
        entityType: 'driver',
        entityId: 'd1',
        action: 'created',
        performedBy: 'u1',
        timestamp: Date.now(),
      };
      await ctx.db.insert('auditLog', { ...base, organizationId: ORG_A });
      await ctx.db.insert('auditLog', { ...base, organizationId: ORG_A });
      await ctx.db.insert('auditLog', { ...base, organizationId: ORG_B });

      const aLogs = await queryByOrg(ctx, 'auditLog', ORG_A).collect();
      const bLogs = await queryByOrg(ctx, 'auditLog', ORG_B).collect();

      expect(aLogs).toHaveLength(2);
      expect(bLogs).toHaveLength(1);
      expect(aLogs.every((l) => l.organizationId === ORG_A)).toBe(true);
    });
  });

  it('preserves chainability — .order().take() works', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const base = {
        entityType: 'driver',
        entityId: 'd1',
        action: 'created',
        performedBy: 'u1',
        organizationId: ORG_A,
      };
      await ctx.db.insert('auditLog', { ...base, timestamp: 1000 });
      await ctx.db.insert('auditLog', { ...base, timestamp: 2000 });
      await ctx.db.insert('auditLog', { ...base, timestamp: 3000 });

      const recent = await queryByOrg(ctx, 'auditLog', ORG_A).order('desc').take(2);
      expect(recent.map((l) => l.timestamp)).toEqual([3000, 2000]);
    });
  });
});
