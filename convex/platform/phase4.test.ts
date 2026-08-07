/**
 * Phase 4 tests: Stripe webhook signature verification, payment
 * application idempotency, push bookkeeping, and the SLO overview.
 * (The Stripe fetch calls themselves are exercised against the live API
 * only — everything on our side of the boundary is covered here.)
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { verifyStripeSignature } from './stripe';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_p4';
const STAFF_EMAIL = 'ops@otoqa.com';
const WORKOS_ORG = 'org_workos_phase4';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.STAFF_ISSUER = process.env.STAFF_ISSUER;
  savedEnv.STAFF_EMAIL_ALLOWLIST = process.env.STAFF_EMAIL_ALLOWLIST;
  process.env.STAFF_ISSUER = STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = STAFF_EMAIL;
});

afterEach(() => {
  process.env.STAFF_ISSUER = savedEnv.STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = savedEnv.STAFF_EMAIL_ALLOWLIST;
});

const staff = () =>
  ({
    issuer: STAFF_ISSUER,
    subject: 'staff_p4',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000),
  }) as never;

async function signPayload(payload: string, secret: string, t: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${t},v1=${hex}`;
}

describe('phase 4 — Stripe webhook signature', () => {
  const SECRET = 'whsec_test_secret';
  const PAYLOAD = '{"type":"invoice.paid"}';

  it('accepts a valid, fresh signature', async () => {
    const now = Date.now();
    const header = await signPayload(PAYLOAD, SECRET, Math.floor(now / 1000));
    expect(await verifyStripeSignature(PAYLOAD, header, SECRET, now)).toBe(true);
  });

  it('rejects tampered payloads, wrong secrets, stale timestamps, and junk', async () => {
    const now = Date.now();
    const header = await signPayload(PAYLOAD, SECRET, Math.floor(now / 1000));
    expect(await verifyStripeSignature('{"type":"evil"}', header, SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(PAYLOAD, header, 'whsec_other', now)).toBe(false);
    const stale = await signPayload(PAYLOAD, SECRET, Math.floor(now / 1000) - 600);
    expect(await verifyStripeSignature(PAYLOAD, stale, SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(PAYLOAD, null, SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(PAYLOAD, 't=abc', SECRET, now)).toBe(false);
  });
});

async function seedIssuedInvoice(ctx: MutationCtx, stripeInvoiceId?: string) {
  const now = Date.now();
  return await ctx.db.insert('platformInvoices', {
    workosOrgId: WORKOS_ORG,
    periodKey: '2026-07',
    invoiceNumber: 'INV-TEST-0031',
    loadsWritten: 100,
    ratePerLoad: 3,
    lines: [{ kind: 'usage', label: '100 loads × $3.00', amount: 300 }],
    adjustments: [],
    subtotal: 300,
    total: 300,
    payments: [],
    amountPaid: 0,
    status: 'issued',
    issuedAt: now,
    dueAt: now + 15 * 86_400_000,
    stripeInvoiceId,
    createdAt: now,
    updatedAt: now,
  });
}

describe('phase 4 — Stripe payment application', () => {
  it('applies invoice.paid once; duplicates and unknown ids are safe', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedIssuedInvoice(ctx, 'in_stripe_123'));

    await t.mutation(internal.platform.stripe.applyStripeInvoicePaid, {
      stripeInvoiceId: 'in_stripe_123',
      amountPaidCents: 30000,
    });
    // Duplicate delivery — no double payment.
    await t.mutation(internal.platform.stripe.applyStripeInvoicePaid, {
      stripeInvoiceId: 'in_stripe_123',
      amountPaidCents: 30000,
    });
    // Unknown id — logged, not thrown.
    await t.mutation(internal.platform.stripe.applyStripeInvoicePaid, {
      stripeInvoiceId: 'in_unknown',
      amountPaidCents: 100,
    });

    const s = t.withIdentity(staff());
    const [inv] = await s.query(api.platform.invoices.listInvoices, { status: 'paid' });
    expect(inv).toMatchObject({ amountPaid: 300, status: 'paid' });
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0]).toMatchObject({ method: 'stripe', reference: 'in_stripe_123' });

    const events = await s.query(api.platform.events.recentEvents, {});
    expect(events.some((e) => e.code === 'stripe.unknown_invoice')).toBe(true);
  });

  it('markPushedToStripe links the row, flips to sent, and audits', async () => {
    const t = convexTest(schema);
    const id = await t.run((ctx) => seedIssuedInvoice(ctx));
    await t.mutation(internal.platform.stripe.markPushedToStripe, {
      id,
      stripeInvoiceId: 'in_new_1',
      stripeHostedInvoiceUrl: 'https://invoice.stripe.com/i/x',
      actorEmail: STAFF_EMAIL,
    });
    const s = t.withIdentity(staff());
    const [inv] = await s.query(api.platform.invoices.listInvoices, { status: 'sent' });
    expect(inv).toMatchObject({
      stripeInvoiceId: 'in_new_1',
      stripeHostedInvoiceUrl: 'https://invoice.stripe.com/i/x',
    });
    const audit = await s.query(api.platform.access.recentAuditLog, {});
    expect(audit[0].action).toBe('invoice_sent');
  });

  it('payment_failed logs a warn event with the org attributed', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedIssuedInvoice(ctx, 'in_fail_1'));
    await t.mutation(internal.platform.stripe.recordStripePaymentFailed, {
      stripeInvoiceId: 'in_fail_1',
    });
    const s = t.withIdentity(staff());
    const [event] = await s.query(api.platform.events.recentEvents, {});
    expect(event).toMatchObject({ code: 'stripe.payment_failed', orgId: WORKOS_ORG });
  });
});

describe('phase 4 — SLO overview', () => {
  it('is staff-gated and aggregates the ledgers', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHealth', {
        jobName: 'j1',
        lastStartedAt: Date.now(),
        lastFinishedAt: Date.now(),
        lastDurationMs: 10,
        lastOutcome: 'ok',
        consecutiveFailures: 0,
        totalRuns: 90,
        totalFailures: 9,
        updatedAt: Date.now(),
      });
    });

    await expect(
      t
        .withIdentity({ issuer: 'https://other', subject: 'x', email: STAFF_EMAIL } as never)
        .query(api.platform.slo.sloOverview, {}),
    ).rejects.toThrow(/Not platform staff/);

    const slo = await t.withIdentity(staff()).query(api.platform.slo.sloOverview, {});
    expect(slo.cron).toMatchObject({ jobs: 1, totalRuns: 90, totalFailures: 9 });
    expect(slo.cron.successRate).toBeCloseTo(0.9, 5);
    expect(slo.partnerApi.sample).toBe(0);
    expect(slo.webhooks.successRate).toBeNull();
  });
});
