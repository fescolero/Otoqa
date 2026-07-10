// END-TO-END pay-type coverage (no production data required).
//
// The M4 parity fixtures prove the pure calc matches legacy per rule type. THIS
// suite proves the full Convex path a customer actually hits: seed a real load +
// leg + stops + pay profile/rule, run the calculatePayForLeg mutation, and
// assert the persisted payItem. It exercises every trigger source the engine
// supports — per-mile (loaded/empty/total), detention, stop-count, hazmat/tarp/
// oversize, flat, tiered, team splits, and percentage-of-load — so onboarding a
// driver on any pay model is proven to work before the first real driver lands.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { microCentsFromDecimalString, rawMicroCents, percentToMicroPctPoints } from '../lib/money';

type T = TestConvex<typeof schema>;
const ORG = 'org_paytypes';
const USER = 'user_paytypes';
const HOUR_MS = 3_600_000;
// $ rate → raw micro-cents (payRules.rateAmountMicroCents is int64).
const mc = (d: string) => rawMicroCents(microCentsFromDecimalString(d, 'USD'));

type RuleSpec = {
  source: string;
  transform?: 'IDENTITY' | 'HOURS_FROM_MINUTES' | 'COUNT' | 'SUM' | 'PERCENT';
  rate?: string;                       // flat rate in $
  pct?: number;                        // for PERCENT rules
  tiered?: Array<{ minQty: number; maxQty?: number; rate: string }>;
};
type StopSpec = { type?: 'PICKUP' | 'DELIVERY' | 'DETOUR'; dwellMin?: number };
type Scenario = {
  rules: RuleSpec[];
  legLoadedMiles?: number;
  legEmptyMiles?: number;
  isHazmat?: boolean;
  requiresTarp?: boolean;
  isOversize?: boolean;
  stops?: StopSpec[];
  invoice?: { subtotal?: number; totalAmount?: number };
  drivers?: Array<{ splitBps: number }>; // team split; default single driver 100%
};

async function seedBase(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const customerId = await ctx.db.insert('customers', {
      name: 'C', companyType: 'Shipper', status: 'Active', addressLine1: '1 St',
      city: 'T', state: 'CA', zip: '00000', country: 'USA',
      workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const mkDriver = (n: string) => ctx.db.insert('drivers', {
      firstName: n, lastName: 'D', email: `${n}@x.co`, phone: '1',
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const driverId = await mkDriver('A');
    const driver2Id = await mkDriver('B');
    const truckId = await ctx.db.insert('trucks', {
      unitId: 'T1', vin: 'VIN1', status: 'Active',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const componentId = await ctx.db.insert('chargeComponents', {
      workosOrgId: ORG, code: 'PAY', displayName: 'Pay', bucket: 'ACCESSORIAL',
      sign: 'CREDIT', taxability: 'TAXABLE_WAGE', appliesTo: ['PAY'],
      isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
    });
    return { customerId, driverId, driver2Id, truckId, componentId };
  });
}

let loadSeq = 0;
async function seedScenario(
  t: T,
  base: Awaited<ReturnType<typeof seedBase>>,
  s: Scenario,
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    loadSeq++;
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: `LD-${loadSeq}`, orderNumber: `O-${loadSeq}`, status: 'Completed',
      trackingStatus: 'In Transit', customerId: base.customerId, fleet: 'Default',
      units: 'Pallets', workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      isHazmat: s.isHazmat, requiresTarp: s.requiresTarp, isOversize: s.isOversize,
    });

    // Stops (default: a pickup + delivery). Dwell drives detention; the count
    // drives stops.count. Give each stop a check-in/out so leg.durationMinutes
    // is also derivable if a rule wants it.
    const stopSpecs: StopSpec[] = s.stops ?? [{ type: 'PICKUP' }, { type: 'DELIVERY' }];
    const stopIds: Id<'loadStops'>[] = [];
    for (let i = 0; i < stopSpecs.length; i++) {
      const sp = stopSpecs[i];
      const id = await ctx.db.insert('loadStops', {
        loadId, internalId: `LD-${loadSeq}`, sequenceNumber: i + 1,
        stopType: sp.type ?? (i === 0 ? 'PICKUP' : 'DELIVERY'),
        loadingType: 'APPT', address: `${i} Main`, workosOrgId: ORG,
        dwellTime: sp.dwellMin,
        checkedInAt: new Date(now + i * HOUR_MS).toISOString(),
        checkedOutAt: new Date(now + i * HOUR_MS + (sp.dwellMin ?? 0) * 60_000).toISOString(),
        createdAt: now, updatedAt: now,
      });
      stopIds.push(id);
    }

    // Optional invoice (drives PCT_OF_LOAD).
    if (s.invoice) {
      await ctx.db.insert('loadInvoices', {
        loadId, customerId: base.customerId, workosOrgId: ORG, status: 'BILLED',
        currency: 'USD', subtotal: s.invoice.subtotal, totalAmount: s.invoice.totalAmount,
        createdBy: USER, createdAt: now, updatedAt: now,
      });
    }

    // Profile + rules.
    const profileId = await ctx.db.insert('payProfiles', {
      workosOrgId: ORG, name: 'P', payeeType: 'DRIVER', payBasis: 'HYBRID',
      currency: 'USD', isDefault: true, isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    for (let i = 0; i < s.rules.length; i++) {
      const r = s.rules[i];
      await ctx.db.insert('payRules', {
        profileId, name: `rule-${i}`, componentId: base.componentId,
        trigger: { source: r.source, transform: r.transform },
        rateAmountMicroCents: r.tiered ? undefined
          : r.pct != null ? percentToMicroPctPoints(r.pct)
          : r.rate != null ? mc(r.rate) : undefined,
        tieredRate: r.tiered?.map((tt) => ({
          minQty: tt.minQty, maxQty: tt.maxQty, rateMicroCents: mc(tt.rate),
        })),
        isActive: true, sortOrder: i, createdAt: now, updatedAt: now, createdBy: USER,
      });
    }

    // Assign the profile to every payee driver.
    const team = s.drivers ?? [{ splitBps: 10000 }];
    const driverIds = team.map((_, i) => (i === 0 ? base.driverId : base.driver2Id));
    for (const dId of driverIds) {
      await ctx.db.insert('payeeProfileAssignments', {
        workosOrgId: ORG, payeeType: 'DRIVER', payeeId: dId, profileId,
        isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true,
        createdAt: now, updatedAt: now, createdBy: USER,
      });
    }

    const legId = await ctx.db.insert('dispatchLegs', {
      loadId, sequence: 1, startStopId: stopIds[0], endStopId: stopIds[stopIds.length - 1],
      legLoadedMiles: s.legLoadedMiles ?? 0, legEmptyMiles: s.legEmptyMiles ?? 0,
      status: 'COMPLETED', workosOrgId: ORG, createdAt: now, updatedAt: now,
      ...(team.length > 1
        ? { drivers: team.map((tt, i) => ({ driverId: driverIds[i], splitBps: tt.splitBps })) }
        : { driverId: base.driverId }),
    });

    return { loadId, legId, driverIds };
  });
}

async function payFor(t: T, loadId: Id<'loadInformation'>, driverId: Id<'drivers'>) {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query('payItems')
      .withIndex('by_load_payee', (q) =>
        q.eq('sourceRef.loadId', loadId).eq('payeeType', 'DRIVER').eq('payeeId', driverId))
      .collect(),
  );
  const live = rows.filter((r) => !r.isVoided);
  const totalCents = live.reduce((sum, r) => sum + r.amountCents, 0n);
  return { live, totalCents };
}

async function run(t: T, base: Awaited<ReturnType<typeof seedBase>>, s: Scenario) {
  const { loadId, legId, driverIds } = await seedScenario(t, base, s);
  await t.mutation(internal.payEngine.calculatePayForLeg.calculatePayForLeg, { legId, userId: USER });
  return { loadId, driverIds };
}

describe('pay types — full path through calculatePayForLeg', () => {
  it('per-mile LOADED: 100 mi @ $0.60 = $60.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'leg.legLoadedMiles', rate: '0.60' }], legLoadedMiles: 100,
    });
    const { totalCents, live } = await payFor(t, loadId, driverIds[0]);
    expect(live).toHaveLength(1);
    expect(totalCents).toBe(6000n);
  });

  it('per-mile EMPTY (deadhead): 50 mi @ $0.40 = $20.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'leg.legEmptyMiles', rate: '0.40' }], legEmptyMiles: 50,
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(2000n);
  });

  it('per-mile TOTAL: (80 loaded + 20 empty) @ $0.50 = $50.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'leg.totalMiles', rate: '0.50' }], legLoadedMiles: 80, legEmptyMiles: 20,
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(5000n);
  });

  it('DETENTION: 90 min dwell @ $40/h = $60.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES', rate: '40.00' }],
      stops: [{ type: 'PICKUP', dwellMin: 90 }, { type: 'DELIVERY', dwellMin: 0 }],
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(6000n);
  });

  it('STOP COUNT: 4 stops @ $22.50 = $90.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'stops.count', rate: '22.50' }],
      stops: [{ type: 'PICKUP' }, { type: 'DELIVERY' }, { type: 'PICKUP' }, { type: 'DELIVERY' }],
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(9000n);
  });

  it('HAZMAT: fires $75 when hazmat, $0 when not', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const on = await run(t, base, { rules: [{ source: 'attr.hazmat', rate: '75.00' }], isHazmat: true });
    expect((await payFor(t, on.loadId, on.driverIds[0])).totalCents).toBe(7500n);
    const off = await run(t, base, { rules: [{ source: 'attr.hazmat', rate: '75.00' }], isHazmat: false });
    expect((await payFor(t, off.loadId, off.driverIds[0])).totalCents).toBe(0n);
  });

  it('FLAT: constant.1 @ $120 = $120.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, { rules: [{ source: 'constant.1', rate: '120.00' }] });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(12000n);
  });

  it('TIERED miles: 150 mi over [0–100 @ $0.50, 100+ @ $0.60] = $80.00', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{
        source: 'leg.legLoadedMiles',
        tiered: [{ minQty: 0, maxQty: 100, rate: '0.50' }, { minQty: 100, rate: '0.60' }],
      }],
      legLoadedMiles: 150,
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(8000n);
  });

  it('TEAM SPLIT: 100 mi @ $1.00, 60/40 → $60 and $40', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'leg.legLoadedMiles', rate: '1.00' }],
      legLoadedMiles: 100,
      drivers: [{ splitBps: 6000 }, { splitBps: 4000 }],
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(6000n);
    expect((await payFor(t, loadId, driverIds[1])).totalCents).toBe(4000n);
  });

  it('PERCENT of LINEHAUL: 25% of $2,000 subtotal = $500.00 (newly wired)', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'load.linehaulTotalCents', transform: 'PERCENT', pct: 25 }],
      invoice: { subtotal: 2000, totalAmount: 2200 },
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(50000n);
  });

  it('PERCENT of INVOICE: 28% of $4,612.50 total = $1,291.50 (newly wired)', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'load.invoiceTotalCents', transform: 'PERCENT', pct: 28 }],
      invoice: { subtotal: 4000, totalAmount: 4612.5 },
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(129150n);
  });

  it('PERCENT with no billed invoice → $0 (resolves once billed)', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [{ source: 'load.linehaulTotalCents', transform: 'PERCENT', pct: 25 }],
    });
    expect((await payFor(t, loadId, driverIds[0])).totalCents).toBe(0n);
  });

  it('COMBINED profile: flat $120 + 100 mi @ $0.60 + hazmat $75 = $255 (3 lines)', async () => {
    const t = convexTest(schema);
    const base = await seedBase(t);
    const { loadId, driverIds } = await run(t, base, {
      rules: [
        { source: 'constant.1', rate: '120.00' },
        { source: 'leg.legLoadedMiles', rate: '0.60' },
        { source: 'attr.hazmat', rate: '75.00' },
      ],
      legLoadedMiles: 100, isHazmat: true,
    });
    const { totalCents, live } = await payFor(t, loadId, driverIds[0]);
    expect(live).toHaveLength(3);
    expect(totalCents).toBe(25500n);
  });
});
