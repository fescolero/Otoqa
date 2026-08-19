import { v, ConvexError } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { logSystemEvent } from '../lib/systemEvents';
import type { ActionCtx } from '../_generated/server';
import { trackedFetch } from '../lib/externalHealth';

/**
 * Stripe integration (Phase 4 — spec §7). ACH-first Stripe Invoicing:
 * we push our FROZEN invoice as a single-line Stripe invoice
 * (collection_method=send_invoice → Stripe hosts the payment page, emails
 * the customer, and runs its own reminders), and the webhook flips our row
 * to paid. Stripe never computes our amounts — the ledger stays the
 * record of truth, and the nightly reconcile flags any disagreement
 * instead of correcting it.
 *
 * Disabled-by-default: every entry point exits with a clear error/no-op
 * when STRIPE_SECRET_KEY is unset. Uses Stripe's REST API via fetch
 * (form-encoded) — no SDK dependency.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

function stripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ConvexError('Stripe is not configured (STRIPE_SECRET_KEY unset)');
  return key;
}

async function stripeFetch(
  ctx: Pick<ActionCtx, 'runMutation'>,
  path: string,
  params?: Record<string, string>,
  method: 'POST' | 'GET' = params ? 'POST' : 'GET',
): Promise<Record<string, unknown>> {
  const res = await trackedFetch(ctx, 'stripe', `${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' && params ? new URLSearchParams(params).toString() : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new ConvexError(`Stripe ${method} ${path}: ${err}`);
  }
  return json;
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature: t=...,v1=...).
 * WebCrypto HMAC-SHA256 over `${t}.${payload}`; 5-minute replay tolerance.
 * Exported for http.ts and tests.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = new Map(
    signatureHeader.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx), p.slice(idx + 1)] as const;
    }),
  );
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !v1) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > 300) return false; // replay window

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Constant-time-ish comparison.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ─── Push an issued invoice to Stripe ────────────────────────────────────

export const getInvoiceForPush = internalQuery({
  args: { id: v.id('platformInvoices') },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.id);
    if (!invoice) return null;
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', invoice.workosOrgId))
      .unique();
    const sensitive = org
      ? await ctx.db
          .query('organizations_sensitive')
          .withIndex('by_org', (q) => q.eq('organizationId', org._id))
          .unique()
      : null;
    return {
      invoice,
      org: org
        ? {
            _id: org._id,
            name: org.name,
            billingEmail: org.billingEmail,
            billingTerms: org.billingTerms,
          }
        : null,
      stripeCustomerId: sensitive?.stripeCustomerId ?? null,
    };
  },
});

export const setStripeCustomer = internalMutation({
  args: { organizationId: v.id('organizations'), stripeCustomerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('organizations_sensitive')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        stripeCustomerId: args.stripeCustomerId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert('organizations_sensitive', {
        organizationId: args.organizationId,
        stripeCustomerId: args.stripeCustomerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const markPushedToStripe = internalMutation({
  args: {
    id: v.id('platformInvoices'),
    stripeInvoiceId: v.string(),
    stripeHostedInvoiceUrl: v.optional(v.string()),
    actorEmail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    await ctx.db.patch(args.id, {
      stripeInvoiceId: args.stripeInvoiceId,
      stripeHostedInvoiceUrl: args.stripeHostedInvoiceUrl,
      // Stripe emails the hosted invoice on send. A partially-paid invoice
      // keeps that status — it describes the money, not the delivery — while
      // `sentAt` records the delivery independently, which is what a later
      // reversal reads to walk the status back to 'sent' rather than 'issued'.
      status: invoice.status === 'partially_paid' ? invoice.status : 'sent',
      sentAt: Date.now(),
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: args.actorEmail,
      action: 'invoice_sent',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      metadata: JSON.stringify({ via: 'stripe', stripeInvoiceId: args.stripeInvoiceId }),
    });
    return null;
  },
});

export const pushInvoiceToStripe = action({
  args: { id: v.id('platformInvoices') },
  handler: async (ctx, args): Promise<{ stripeInvoiceId: string; hostedInvoiceUrl?: string }> => {
    const staff = await requireRecentStaffAuth(ctx);
    const data = await ctx.runQuery(internal.platform.stripe.getInvoiceForPush, { id: args.id });
    if (!data || !data.org) throw new ConvexError('Invoice or organization not found');
    const { invoice, org } = data;
    // 'partially_paid' is pushable: applying an org credit at issue can move
    // an invoice straight into that state, and refusing here would make a
    // credited invoice impossible to collect through Stripe.
    if (invoice.status !== 'issued' && invoice.status !== 'partially_paid') {
      throw new ConvexError('Only issued invoices can be pushed to Stripe');
    }
    if (invoice.stripeInvoiceId) {
      throw new ConvexError(`Already pushed as ${invoice.stripeInvoiceId}`);
    }

    // Collect the BALANCE, not the face value. Credits applied at issue and
    // payments already recorded are money we are not owed again — pushing
    // `total` here would bill the customer twice for the credited portion.
    const balance = Math.round((invoice.total - invoice.amountPaid) * 100) / 100;
    if (balance <= 0) {
      throw new ConvexError(
        'Nothing left to collect on this invoice — it is already covered by payments or credit',
      );
    }

    // 1. Ensure the Stripe customer.
    let customerId = data.stripeCustomerId;
    if (!customerId) {
      const customer = await stripeFetch(ctx, '/customers', {
        name: org.name,
        email: org.billingEmail ?? '',
        'metadata[workosOrgId]': invoice.workosOrgId,
      });
      customerId = customer.id as string;
      await ctx.runMutation(internal.platform.stripe.setStripeCustomer, {
        organizationId: org._id,
        stripeCustomerId: customerId,
      });
    }

    // 2. One line item carrying OUR frozen balance — Stripe never recomputes.
    const credited = Math.round((invoice.total - balance) * 100) / 100;
    await stripeFetch(ctx, '/invoiceitems', {
      customer: customerId,
      amount: String(Math.round(balance * 100)),
      currency: 'usd',
      description:
        `Otoqa platform — ${invoice.periodKey} (${invoice.invoiceNumber})` +
        (credited > 0 ? ` — $${credited.toFixed(2)} already applied` : ''),
    });

    // 3. Hosted invoice, ACH-first, due date mirroring our terms.
    const daysUntilDue = invoice.dueAt
      ? Math.max(1, Math.ceil((invoice.dueAt - Date.now()) / 86_400_000))
      : 15;
    const stripeInvoice = await stripeFetch(ctx, '/invoices', {
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: String(daysUntilDue),
      'payment_settings[payment_method_types][0]': 'us_bank_account',
      'payment_settings[payment_method_types][1]': 'card',
      'metadata[invoiceNumber]': invoice.invoiceNumber,
      'metadata[periodKey]': invoice.periodKey,
    });
    const stripeInvoiceId = stripeInvoice.id as string;
    const finalized = await stripeFetch(ctx, `/invoices/${stripeInvoiceId}/finalize`, {});
    await stripeFetch(ctx, `/invoices/${stripeInvoiceId}/send`, {});

    await ctx.runMutation(internal.platform.stripe.markPushedToStripe, {
      id: args.id,
      stripeInvoiceId,
      stripeHostedInvoiceUrl: (finalized.hosted_invoice_url as string) ?? undefined,
      actorEmail: staff.email,
    });
    return {
      stripeInvoiceId,
      hostedInvoiceUrl: (finalized.hosted_invoice_url as string) ?? undefined,
    };
  },
});

// ─── Webhook application ─────────────────────────────────────────────────

/**
 * invoice.paid → record the payment on our row. Idempotent: an invoice
 * already paid (or a duplicate webhook delivery) is a no-op. Amount comes
 * from Stripe's amount_paid; a mismatch against our balance still records
 * (partial payments are legal) — reconcile surfaces persistent gaps.
 */
export const applyStripeInvoicePaid = internalMutation({
  args: { stripeInvoiceId: v.string(), amountPaidCents: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invoice = await ctx.db
      .query('platformInvoices')
      .withIndex('by_stripe_invoice', (q) => q.eq('stripeInvoiceId', args.stripeInvoiceId))
      .unique();
    if (!invoice) {
      await logSystemEvent(ctx, {
        severity: 'warn',
        source: 'stripe',
        code: 'stripe.unknown_invoice',
        message: `invoice.paid for unknown Stripe invoice ${args.stripeInvoiceId}`,
      });
      return null;
    }
    if (invoice.status === 'paid' || invoice.status === 'void') return null; // idempotent
    // A Stripe payment landing on an invoice we already gave up on is
    // bad-debt recovery. Record it, but never let it pass silently — the
    // write-off was a deliberate decision someone should know was reversed.
    if (invoice.status === 'written_off') {
      await logSystemEvent(ctx, {
        severity: 'warn',
        source: 'stripe',
        code: 'stripe.paid_after_write_off',
        message: `${invoice.invoiceNumber} was written off but Stripe collected payment — recovery recorded`,
        orgId: invoice.workosOrgId,
      });
    }

    const amount = Math.round(args.amountPaidCents) / 100;
    const payments = [
      ...invoice.payments,
      {
        id: `pay_${invoice.payments.length}_${invoice.periodKey}`,
        amount,
        method: 'stripe' as const,
        reference: args.stripeInvoiceId,
        recordedByEmail: 'system:stripe-webhook',
        receivedAt: Date.now(),
      },
    ];
    // Sum the ledger rather than incrementing: reversals are negative entries,
    // so an incremented counter would drift away from the payment history.
    const amountPaid = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    const paidInFull = amountPaid >= invoice.total;
    await ctx.db.patch(invoice._id, {
      payments,
      amountPaid,
      ...(paidInFull
        ? { status: 'paid' as const, paidAt: Date.now() }
        : invoice.status === 'issued' || invoice.status === 'sent'
          ? { status: 'partially_paid' as const }
          : {}),
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: 'system:stripe-webhook',
      action: 'invoice_payment_recorded',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: invoice._id,
      metadata: JSON.stringify({ amount, stripeInvoiceId: args.stripeInvoiceId, paidInFull }),
    });
    return null;
  },
});

export const recordStripePaymentFailed = internalMutation({
  args: { stripeInvoiceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invoice = await ctx.db
      .query('platformInvoices')
      .withIndex('by_stripe_invoice', (q) => q.eq('stripeInvoiceId', args.stripeInvoiceId))
      .unique();
    await logSystemEvent(ctx, {
      severity: 'warn',
      source: 'stripe',
      code: 'stripe.payment_failed',
      message: `Stripe payment failed for ${invoice?.invoiceNumber ?? args.stripeInvoiceId}`,
      orgId: invoice?.workosOrgId,
    });
    return null;
  },
});

// ─── Nightly reconciliation ──────────────────────────────────────────────

export const listPushedOpenInvoices = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Every status that still represents an open obligation — omitting
    // 'partially_paid' would drop part-paid invoices out of reconciliation
    // entirely, which is exactly where a missed webhook hides.
    const open = (
      await Promise.all(
        (['issued', 'sent', 'partially_paid'] as const).map((status) =>
          ctx.db
            .query('platformInvoices')
            .withIndex('by_status', (q) => q.eq('status', status))
            .take(200),
        ),
      )
    ).flat();
    return open
      .filter((i) => i.stripeInvoiceId)
      .map((i) => ({
        id: i._id,
        stripeInvoiceId: i.stripeInvoiceId!,
        // The outstanding balance is what Stripe was asked to collect.
        total: Math.round((i.total - i.amountPaid) * 100) / 100,
      }));
  },
});

export const flagReconcileMismatch = internalMutation({
  args: { stripeInvoiceId: v.string(), stripeStatus: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await logSystemEvent(ctx, {
      severity: 'warn',
      source: 'stripe',
      code: 'stripe.reconcile_mismatch',
      message: `Stripe invoice ${args.stripeInvoiceId} is ${args.stripeStatus} but the ledger row is still open`,
    });
    return null;
  },
});

export const reconcileStripeInvoices = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!process.env.STRIPE_SECRET_KEY) return null; // integration off — no-op
    const open = await ctx.runQuery(internal.platform.stripe.listPushedOpenInvoices, {});
    for (const row of open) {
      try {
        const stripeInvoice = await stripeFetch(ctx, `/invoices/${row.stripeInvoiceId}`);
        if (stripeInvoice.status === 'paid') {
          // Missed/failed webhook — apply now (idempotent).
          await ctx.runMutation(internal.platform.stripe.applyStripeInvoicePaid, {
            stripeInvoiceId: row.stripeInvoiceId,
            amountPaidCents: (stripeInvoice.amount_paid as number) ?? Math.round(row.total * 100),
          });
        } else if (stripeInvoice.status === 'void' || stripeInvoice.status === 'uncollectible') {
          await ctx.runMutation(internal.platform.stripe.flagReconcileMismatch, {
            stripeInvoiceId: row.stripeInvoiceId,
            stripeStatus: stripeInvoice.status as string,
          });
        }
      } catch (e) {
        console.error(`[stripe] reconcile ${row.stripeInvoiceId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return null;
  },
});
