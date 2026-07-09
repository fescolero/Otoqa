// Payee-scoped mobile settlement reads — drivers and carrier owners see only
// their OWN statements, VOID stays hidden, and the broker org's
// settlements_read_ledger flag picks the ledger exactly like the web dashboard.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

type T = TestConvex<typeof schema>;
const BROKER_ORG = 'org_broker_mobile';
const USER = 'user_admin';
const DAY = 86_400_000;
const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';

const driverIdentity = (subject: string, phone: string) => ({
  subject,
  issuer: 'https://relaxed-swan-1.clerk.accounts.dev',
  phoneNumber: phone,
});

async function seedDrivers(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const mkDriver = (phone: string, firstName: string) =>
      ctx.db.insert('drivers', {
        firstName, lastName: 'Test', email: `${firstName}@t.co`, phone,
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: BROKER_ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
    const driverA = await mkDriver(PHONE_A, 'Ana');
    const driverB = await mkDriver(PHONE_B, 'Ben');

    const mkSettlement = (
      driverId: Id<'drivers'>,
      status: 'DRAFT' | 'PAID' | 'VOID',
      periodStart: number,
      periodEnd: number,
      statementNumber: string,
    ) =>
      ctx.db.insert('driverSettlements', {
        driverId, workosOrgId: BROKER_ORG, periodStart, periodEnd, status,
        statementNumber, createdAt: now, createdBy: USER, updatedAt: now,
        ...(status === 'PAID'
          ? { paidAt: now - DAY, paidMethod: 'ACH', paidReference: 'TX-1' }
          : {}),
      });
    // Driver A: an accruing draft (period still open), a paid statement, a void.
    const draft = await mkSettlement(driverA, 'DRAFT', now - 3 * DAY, now + 4 * DAY, 'SET-2026-101');
    const paid = await mkSettlement(driverA, 'PAID', now - 20 * DAY, now - 10 * DAY, 'SET-2026-100');
    await mkSettlement(driverA, 'VOID', now - 40 * DAY, now - 30 * DAY, 'SET-2026-099');
    // Driver B: their own draft — must never appear for A.
    const otherDraft = await mkSettlement(driverB, 'DRAFT', now - 3 * DAY, now + 4 * DAY, 'SET-2026-102');

    const mkPayable = (
      driverId: Id<'drivers'>,
      settlementId: Id<'driverSettlements'>,
      totalAmount: number,
      opts?: { desc?: string; manual?: boolean; category?: 'DEDUCTION' },
    ) =>
      ctx.db.insert('loadPayables', {
        driverId, description: opts?.desc ?? 'Base Hour', quantity: 10,
        rate: totalAmount / 10, totalAmount,
        sourceType: opts?.manual ? 'MANUAL' : 'SYSTEM', isLocked: false,
        settlementId, workosOrgId: BROKER_ORG,
        createdAt: now - 2 * DAY, createdBy: USER,
        ...(opts?.category ? { category: opts.category } : {}),
      });
    await mkPayable(driverA, draft, 500);
    await mkPayable(driverA, draft, -50, { desc: 'Advance', manual: true, category: 'DEDUCTION' });
    await mkPayable(driverA, paid, 800);
    await mkPayable(driverB, otherDraft, 999);

    return { driverA, driverB, draft, paid, otherDraft };
  });
}

describe('mobileSettlements — driver (legacy ledger)', () => {
  it('lists only the authenticated driver’s statements, hides VOID, maps statuses', async () => {
    const t = convexTest(schema);
    await seedDrivers(t);
    const asA = t.withIdentity(driverIdentity('clerk_a', PHONE_A));

    const rows = await asA.query(api.mobileSettlements.getMyStatements, {});
    expect(rows).toHaveLength(2); // VOID hidden, driver B's row absent
    expect(rows.map((r: any) => r.statementNumber)).toEqual(['SET-2026-101', 'SET-2026-100']);

    const accruing = rows[0];
    expect(accruing.status).toBe('ACCRUING'); // DRAFT + period still running
    expect(accruing.source).toBe('legacy');
    expect(accruing.earnTotal).toBe(500);
    expect(accruing.deductTotal).toBe(50);
    expect(accruing.net).toBe(450);

    const paid = rows[1];
    expect(paid.status).toBe('PAID');
    expect(paid.paidMethod).toBe('ACH');
    expect(paid.paidReference).toBe('TX-1');
    expect(paid.net).toBe(800);

    // No leakage of driver B's $999 line anywhere.
    expect(rows.some((r: any) => r.net === 999)).toBe(false);
  });

  it('statement details: itemized lines with signed deduction; other drivers are rejected', async () => {
    const t = convexTest(schema);
    const { draft } = await seedDrivers(t);
    const asA = t.withIdentity(driverIdentity('clerk_a', PHONE_A));
    const asB = t.withIdentity(driverIdentity('clerk_b', PHONE_B));

    const details = await asA.query(api.mobileSettlements.getMyStatementDetails, {
      settlementId: draft as string,
      source: 'legacy',
    });
    expect(details.statement.status).toBe('ACCRUING');
    expect(details.lines).toHaveLength(2);
    const deduction = details.lines.find((l: any) => l.category === 'DEDUCTION');
    expect(deduction?.totalAmount).toBe(-50);
    expect(deduction?.kind).toBe('MANUAL');
    expect(details.summary.net).toBe(450);
    expect(details.linesTruncated).toBe(false);

    // Driver B may not read driver A's statement.
    await expect(
      asB.query(api.mobileSettlements.getMyStatementDetails, {
        settlementId: draft as string,
        source: 'legacy',
      }),
    ).rejects.toThrow('Statement not found');
  });
});

describe('mobileSettlements — driver (flag-gated new ledger)', () => {
  it('settlements_read_ledger=new switches the driver to payEngine rows', async () => {
    const t = convexTest(schema);
    const { driverA } = await seedDrivers(t);

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('featureFlags', {
        workosOrgId: BROKER_ORG, key: 'settlements_read_ledger', value: 'new',
        updatedAt: now, updatedBy: USER,
      });
      const wageComp = await ctx.db.insert('chargeComponents', {
        workosOrgId: BROKER_ORG, code: 'WAGE_HOURLY', displayName: 'Hourly',
        bucket: 'BASE_WAGE', sign: 'CREDIT', taxability: 'NONE', appliesTo: ['PAY'],
        isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
      });
      const settlementId = await ctx.db.insert('settlements', {
        workosOrgId: BROKER_ORG, statementNumber: 'SET-NEW-1', payeeType: 'DRIVER',
        payeeId: driverA as string, periodStart: now - 3 * DAY, periodEnd: now + 4 * DAY,
        currency: 'USD', status: 'OPEN',
        totals: {
          earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
          taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
          grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
        },
        componentTotals: [], createdAt: now, updatedAt: now, createdBy: USER,
      });
      await ctx.db.insert('payItems', {
        workosOrgId: BROKER_ORG, payeeType: 'DRIVER', payeeId: driverA as string,
        kind: 'EARNING', componentId: wageComp, lifecycleStatus: 'APPLIED',
        description: 'Base Wage', quantity: 12, rateMicroCents: 10_000_000n,
        amountCents: 120_000n, currency: 'USD', periodAnchorAt: now - 2 * DAY,
        settlementId, sourceRef: { kind: 'RATE_RULE', id: 'r' },
        isLocked: false, isVoided: false, createdAt: now, updatedAt: now, createdBy: USER,
      });
    });

    const asA = t.withIdentity(driverIdentity('clerk_a', PHONE_A));
    const rows = await asA.query(api.mobileSettlements.getMyStatements, {});
    expect(rows).toHaveLength(1); // legacy rows are NOT mixed in
    expect(rows[0].source).toBe('ledger');
    expect(rows[0].statementNumber).toBe('SET-NEW-1');
    expect(rows[0].status).toBe('ACCRUING'); // OPEN → DRAFT → period running
    expect(rows[0].net).toBe(1200);

    const details = await asA.query(api.mobileSettlements.getMyStatementDetails, {
      settlementId: rows[0].id,
      source: 'ledger',
    });
    expect(details.lines).toHaveLength(1);
    expect(details.lines[0].totalAmount).toBe(1200);
    expect(details.lines[0].rate).toBe(100); // 10,000,000 microcents → $100/h
    expect(details.summary.net).toBe(1200);
  });
});

// ── carrier owner ────────────────────────────────────────────────────────────

const CARRIER_EXT_ORG = 'carrier_org_ext_1';
const OWNER_CLERK = 'clerk_owner_1';

async function seedCarrier(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const billingAddress = {
      addressLine1: '1 Way', city: 'Fresno', state: 'CA', zip: '93650', country: 'US',
    };
    const carrierOrgDoc = await ctx.db.insert('organizations', {
      clerkOrgId: CARRIER_EXT_ORG, orgType: 'CARRIER', name: 'Rivera Trucking',
      billingEmail: 'own@rivera.co', billingAddress, subscriptionPlan: 'Basic',
      subscriptionStatus: 'Active', billingCycle: 'Monthly', createdAt: now, updatedAt: now,
    });
    await ctx.db.insert('organizations', {
      workosOrgId: BROKER_ORG, orgType: 'BROKER', name: 'Fames Transport Inc',
      billingEmail: 'ap@fames.co', billingAddress, subscriptionPlan: 'Enterprise',
      subscriptionStatus: 'Active', billingCycle: 'Annual', createdAt: now, updatedAt: now,
    });
    await ctx.db.insert('userIdentityLinks', {
      clerkUserId: OWNER_CLERK, organizationId: carrierOrgDoc, role: 'OWNER',
      createdAt: now, updatedAt: now,
    });
    const partnership = await ctx.db.insert('carrierPartnerships', {
      brokerOrgId: BROKER_ORG, carrierOrgId: CARRIER_EXT_ORG, mcNumber: 'MC123',
      carrierName: 'Rivera Trucking', status: 'ACTIVE', defaultPaymentTerms: 'Net15',
      createdAt: now, updatedAt: now, createdBy: USER,
    });

    const mkSettlement = (
      status: 'DRAFT' | 'PAID' | 'VOID',
      periodStart: number,
      periodEnd: number,
      statementNumber: string,
      totals: { gross: number; net: number; deductions?: number },
    ) =>
      ctx.db.insert('carrierSettlements', {
        carrierPartnershipId: partnership, workosOrgId: BROKER_ORG,
        periodStart, periodEnd, status, statementNumber,
        totalGross: totals.gross, totalNet: totals.net,
        ...(totals.deductions != null ? { totalDeductions: totals.deductions } : {}),
        createdAt: now, createdBy: USER,
        ...(status === 'PAID'
          ? { paidAt: now - DAY, paymentMethod: 'ACH', paymentReference: 'CTX-9' }
          : {}),
      });
    // Closed-period DRAFT (broker review), a PAID statement, a hidden VOID.
    const reviewDraft = await mkSettlement('DRAFT', now - 20 * DAY, now - 6 * DAY, 'CST-2026-050', { gross: 1400, net: 1300, deductions: 100 });
    await mkSettlement('PAID', now - 40 * DAY, now - 26 * DAY, 'CST-2026-049', { gross: 900, net: 900 });
    await mkSettlement('VOID', now - 60 * DAY, now - 46 * DAY, 'CST-2026-048', { gross: 1, net: 1 });

    const mkPayable = (settlementId: Id<'carrierSettlements'>, totalAmount: number, opts?: { manual?: boolean; category?: 'DEDUCTION' }) =>
      ctx.db.insert('loadCarrierPayables', {
        carrierPartnershipId: partnership, description: opts?.category ? 'Chargeback' : 'Base Loaded Miles',
        quantity: 100, rate: totalAmount / 100, totalAmount,
        sourceType: opts?.manual ? 'MANUAL' : 'SYSTEM', isLocked: false,
        settlementId, workosOrgId: BROKER_ORG, createdAt: now - 10 * DAY, createdBy: USER,
        ...(opts?.category ? { category: opts.category } : {}),
      });
    await mkPayable(reviewDraft, 1400);
    await mkPayable(reviewDraft, -100, { manual: true, category: 'DEDUCTION' });

    return { partnership, reviewDraft };
  });
}

describe('mobileSettlements — carrier owner', () => {
  it('lists statements across the partnership with broker name, terms pay date; VOID hidden', async () => {
    const t = convexTest(schema);
    await seedCarrier(t);
    const asOwner = t.withIdentity({ subject: OWNER_CLERK, issuer: 'https://x.clerk.accounts.dev' });

    const rows = await asOwner.query(api.mobileSettlements.getCarrierStatements, {
      carrierOrgId: CARRIER_EXT_ORG,
    });
    expect(rows).toHaveLength(2); // VOID hidden
    expect(rows[0].statementNumber).toBe('CST-2026-050');
    expect(rows[0].status).toBe('IN_REVIEW'); // DRAFT on a closed period
    expect(rows[0].brokerName).toBe('Fames Transport Inc');
    expect(rows[0].earnTotal).toBe(1400); // denormalized totals — no line collect
    expect(rows[0].deductTotal).toBe(100);
    expect(rows[0].net).toBe(1300);
    expect(rows[0].payDate).toBe(rows[0].periodEnd + 15 * DAY); // Net15

    expect(rows[1].status).toBe('PAID');
    expect(rows[1].paidReference).toBe('CTX-9');
  });

  it('statement details itemize lines; a different carrier org is rejected', async () => {
    const t = convexTest(schema);
    const { reviewDraft } = await seedCarrier(t);
    const asOwner = t.withIdentity({ subject: OWNER_CLERK, issuer: 'https://x.clerk.accounts.dev' });

    const details = await asOwner.query(api.mobileSettlements.getCarrierStatementDetails, {
      carrierOrgId: CARRIER_EXT_ORG,
      settlementId: reviewDraft as string,
      source: 'legacy',
    });
    expect(details.statement.brokerName).toBe('Fames Transport Inc');
    expect(details.lines).toHaveLength(2);
    expect(details.summary.net).toBe(1300); // live summarize (not truncated)
    expect(details.linesTruncated).toBe(false);

    // A user from ANOTHER carrier org cannot read it — even claiming the right org id.
    const asStranger = t.withIdentity({ subject: 'clerk_stranger', issuer: 'https://x.clerk.accounts.dev' });
    await expect(
      asStranger.query(api.mobileSettlements.getCarrierStatementDetails, {
        carrierOrgId: CARRIER_EXT_ORG,
        settlementId: reviewDraft as string,
        source: 'legacy',
      }),
    ).rejects.toThrow('Statement not found');
  });
});
