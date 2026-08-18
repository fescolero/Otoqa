/**
 * Expo push pipeline (split-plan §5.7) — the repo's FIRST user-facing
 * push sends (driverPushTokens was write-only; fcmWake is Android-only
 * data wakes). Documented Expo pattern: server POSTs to the Expo Push
 * API, then checks receipts (~15 min later) and prunes tokens the
 * receipts report as DeviceNotRegistered.
 *
 * Flow for high-severity dispatch alerts:
 *   raiseAlert (mutation) ──runAfter(0)──▶ fanoutHighAlert (internalMutation:
 *   reads the org's tokens) ──runAfter(0)──▶ sendBatch (internalAction:
 *   fetch exp.host) ──runAfter(15 min)──▶ checkReceipts (internalAction)
 *   ──▶ pruneToken (internalMutation) for dead devices.
 *
 * No secrets required server-side: Expo brokers to APNs/FCM. Android
 * still needs the app's google-services.json + FCM V1 credentials
 * uploaded to the Dispatch Expo project; iOS APNs is managed by EAS.
 */
import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { trackedFetch } from './lib/externalHealth';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const BATCH = 100;
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** Fan a high-severity alert out to every registered dispatch device in the org. */
export const fanoutHighAlert = internalMutation({
  args: { orgExternalId: v.string(), title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const tokens = await ctx.db
      .query('dispatchPushTokens')
      .withIndex('by_org', (q) => q.eq('orgExternalId', args.orgExternalId))
      .collect();
    if (tokens.length === 0) return;
    await ctx.scheduler.runAfter(0, internal.push.sendBatch, {
      messages: tokens.map((t) => ({
        to: t.token,
        title: args.title,
        body: args.body,
        sound: 'default' as const,
      })),
    });
  },
});

export const sendBatch = internalAction({
  args: {
    messages: v.array(
      v.object({
        to: v.string(),
        title: v.string(),
        body: v.string(),
        sound: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (let i = 0; i < args.messages.length; i += BATCH) {
      const chunk = args.messages.slice(i, i + BATCH);
      const res = await trackedFetch(ctx, 'expo_push', EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        console.error('[push] Expo push API error', res.status, await res.text());
        continue;
      }
      const { data } = (await res.json()) as {
        data: Array<{ status: 'ok' | 'error'; id?: string; details?: { error?: string } }>;
      };
      const receiptToToken: Record<string, string> = {};
      data.forEach((ticket, idx) => {
        const token = chunk[idx].to;
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          void ctx.runMutation(internal.push.pruneToken, { token });
        } else if (ticket.status === 'ok' && ticket.id) {
          receiptToToken[ticket.id] = token;
        }
      });
      if (Object.keys(receiptToToken).length > 0) {
        await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.push.checkReceipts, {
          receiptToToken,
        });
      }
    }
  },
});

export const checkReceipts = internalAction({
  args: { receiptToToken: v.record(v.string(), v.string()) },
  handler: async (ctx, args) => {
    const ids = Object.keys(args.receiptToToken);
    const res = await trackedFetch(ctx, 'expo_push', EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      console.error('[push] receipts API error', res.status);
      return;
    }
    const { data } = (await res.json()) as {
      data: Record<string, { status: 'ok' | 'error'; details?: { error?: string } }>;
    };
    for (const [id, receipt] of Object.entries(data)) {
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        await ctx.runMutation(internal.push.pruneToken, { token: args.receiptToToken[id] });
      }
    }
  },
});

export const pruneToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('dispatchPushTokens')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();
    if (row) await ctx.db.delete(row._id);
  },
});
