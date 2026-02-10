import { v } from 'convex/values';
import {
  action,
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

// ============================================
// WEBHOOK SUBSCRIPTION MANAGEMENT
// ============================================

/**
 * Create a webhook subscription.
 * Uses action (not mutation) because it calls the crypto node action.
 * Returns the raw signing secret (shown once only).
 */
export const createSubscription = action({
  args: {
    workosOrgId: v.string(),
    partnerKeyId: v.id('partnerApiKeys'),
    url: v.string(),
    events: v.array(v.string()),
    intervalMinutes: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    loadSourceFilter: v.optional(v.string()),
  },
  returns: v.object({
    subscriptionId: v.id('webhookSubscriptions'),
    rawSecret: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    // Validate URL is HTTPS
    if (!args.url.startsWith('https://')) {
      throw new Error('Webhook URL must use HTTPS');
    }

    // Validate URL is not a private IP
    try {
      const urlObj = new URL(args.url);
      const hostname = urlObj.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.match(/^172\.(1[6-9]|2\d|3[01])\./)
      ) {
        throw new Error('Webhook URL must not point to a private IP address');
      }
    } catch (e: any) {
      if (e.message.includes('private IP')) throw e;
      throw new Error('Invalid webhook URL');
    }

    // Validate events
    const validEvents = ['position.update', 'status.changed', 'tracking.started', 'tracking.ended'];
    for (const event of args.events) {
      if (!validEvents.includes(event)) {
        throw new Error(`Invalid event type: ${event}. Valid: ${validEvents.join(', ')}`);
      }
    }

    // Generate encrypted secret via node action
    const secretResult: { rawSecret: string; encryptedSecret: string } =
      await ctx.runAction(
        internal.externalTrackingAuthCrypto.generateWebhookSecret,
        {}
      );
    const { rawSecret, encryptedSecret } = secretResult;

    // Save to database via internal mutation
    const subscriptionId: Id<'webhookSubscriptions'> = await ctx.runMutation(
      internal.externalTrackingWebhooks.insertSubscription,
      {
        workosOrgId: args.workosOrgId,
        partnerKeyId: args.partnerKeyId,
        url: args.url,
        events: args.events,
        encryptedSecret,
        intervalMinutes: args.intervalMinutes ?? 5,
        batchSize: args.batchSize ?? 100,
        loadSourceFilter: args.loadSourceFilter,
      }
    );

    return { subscriptionId, rawSecret };
  },
});

/**
 * Internal mutation to insert a webhook subscription (called from action).
 */
export const insertSubscription = internalMutation({
  args: {
    workosOrgId: v.string(),
    partnerKeyId: v.id('partnerApiKeys'),
    url: v.string(),
    events: v.array(v.string()),
    encryptedSecret: v.string(),
    intervalMinutes: v.number(),
    batchSize: v.number(),
    loadSourceFilter: v.optional(v.string()),
  },
  returns: v.id('webhookSubscriptions'),
  handler: async (ctx, args) => {
    // Validate the key belongs to the same org
    const key = await ctx.db.get(args.partnerKeyId);
    if (!key || key.workosOrgId !== args.workosOrgId) throw new Error('API key not found');
    if (key.status !== 'ACTIVE') throw new Error('API key is not active');

    return await ctx.db.insert('webhookSubscriptions', {
      workosOrgId: args.workosOrgId,
      partnerKeyId: args.partnerKeyId,
      url: args.url,
      events: args.events,
      encryptedSecret: args.encryptedSecret,
      intervalMinutes: args.intervalMinutes,
      batchSize: args.batchSize,
      loadSourceFilter: args.loadSourceFilter,
      status: 'ACTIVE',
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * List webhook subscriptions for the org.
 */
export const listSubscriptions = query({
  args: { workosOrgId: v.string() },
  returns: v.array(v.object({
    _id: v.id('webhookSubscriptions'),
    partnerKeyId: v.id('partnerApiKeys'),
    url: v.string(),
    events: v.array(v.string()),
    intervalMinutes: v.number(),
    status: v.string(),
    consecutiveFailures: v.number(),
    lastDeliveredAt: v.optional(v.number()),
    lastFailureReason: v.optional(v.string()),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const subs = await ctx.db
      .query('webhookSubscriptions')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    return subs.map((s) => ({
      _id: s._id,
      partnerKeyId: s.partnerKeyId,
      url: s.url,
      events: s.events,
      intervalMinutes: s.intervalMinutes,
      status: s.status,
      consecutiveFailures: s.consecutiveFailures,
      lastDeliveredAt: s.lastDeliveredAt,
      lastFailureReason: s.lastFailureReason,
      createdAt: s.createdAt,
    }));
  },
});

/**
 * Pause or resume a webhook subscription.
 */
export const updateSubscriptionStatus = mutation({
  args: {
    workosOrgId: v.string(),
    subscriptionId: v.id('webhookSubscriptions'),
    status: v.union(v.literal('ACTIVE'), v.literal('PAUSED')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const sub = await ctx.db.get(args.subscriptionId);
    if (!sub || sub.workosOrgId !== args.workosOrgId) throw new Error('Subscription not found');

    await ctx.db.patch(args.subscriptionId, {
      status: args.status,
      consecutiveFailures: args.status === 'ACTIVE' ? 0 : sub.consecutiveFailures,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// ============================================
// WEBHOOK DELIVERY CRON LOGIC
// ============================================

/**
 * Main cron entry point: find active subscriptions and enqueue deliveries.
 * Runs every 5 minutes.
 */
export const processWebhookDeliveries = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Get all active subscriptions
    const subscriptions: Array<{
      _id: string;
      workosOrgId: string;
      url: string;
      events: string[];
      encryptedSecret: string;
      lastDeliveredAt?: number;
      batchSize?: number;
    }> = await ctx.runQuery(internal.externalTrackingWebhooks.getActiveSubscriptions, {});

    for (const sub of subscriptions) {
      // Get all actively tracking loads for this org
      const result = await ctx.runQuery(internal.externalTracking.listTrackedLoads, {
        workosOrgId: sub.workosOrgId,
        environment: 'production',
        trackingStatusFilter: 'active',
        limit: 100,
      });

      const since = sub.lastDeliveredAt ?? (Date.now() - 5 * 60 * 1000);

      for (const load of result.loads) {
        if (sub.events.includes('position.update')) {
          // Enqueue position delivery
          await ctx.runMutation(internal.externalTrackingWebhooks.enqueueDelivery, {
            subscriptionId: sub._id as Id<'webhookSubscriptions'>,
            workosOrgId: sub.workosOrgId,
            loadId: load.loadRef, // Will be resolved in delivery
            eventType: 'position.update',
            positionsFrom: since,
            positionsTo: Date.now(),
          });
        }
      }

      // Update lastDeliveredAt
      await ctx.runMutation(internal.externalTrackingWebhooks.updateLastDelivered, {
        subscriptionId: sub._id as Id<'webhookSubscriptions'>,
      });
    }

    // Process pending deliveries
    await ctx.runAction(internal.externalTrackingWebhooks.deliverPendingWebhooks, {});

    return null;
  },
});

export const getActiveSubscriptions = internalQuery({
  args: {},
  returns: v.array(v.object({
    _id: v.id('webhookSubscriptions'),
    workosOrgId: v.string(),
    url: v.string(),
    events: v.array(v.string()),
    encryptedSecret: v.string(),
    lastDeliveredAt: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  })),
  handler: async (ctx) => {
    // Get all ACTIVE subscriptions across all orgs
    const subs = await ctx.db
      .query('webhookSubscriptions')
      .withIndex('by_org') // Scan all - cron processes all orgs
      .collect();

    return subs
      .filter((s) => s.status === 'ACTIVE')
      .map((s) => ({
        _id: s._id,
        workosOrgId: s.workosOrgId,
        url: s.url,
        events: s.events,
        encryptedSecret: s.encryptedSecret,
        lastDeliveredAt: s.lastDeliveredAt,
        batchSize: s.batchSize,
      }));
  },
});

export const enqueueDelivery = internalMutation({
  args: {
    subscriptionId: v.id('webhookSubscriptions'),
    workosOrgId: v.string(),
    loadId: v.string(),
    eventType: v.string(),
    positionsFrom: v.optional(v.number()),
    positionsTo: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Generate delivery ID
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const deliveryId = `dlv_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

    // Resolve the loadId - we need the Convex ID
    const load = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('internalId', args.loadId)
      )
      .first();

    if (!load) return null;

    await ctx.db.insert('webhookDeliveryQueue', {
      subscriptionId: args.subscriptionId,
      workosOrgId: args.workosOrgId,
      deliveryId,
      loadId: load._id,
      eventType: args.eventType,
      positionsFrom: args.positionsFrom,
      positionsTo: args.positionsTo,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });

    return null;
  },
});

export const updateLastDelivered = internalMutation({
  args: { subscriptionId: v.id('webhookSubscriptions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.subscriptionId, {
      lastDeliveredAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ============================================
// WEBHOOK DELIVERY ACTION
// ============================================

/**
 * Process pending webhook deliveries.
 * Sends HTTP POST to partner endpoints with signed payloads.
 */
export const deliverPendingWebhooks = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Get pending deliveries
    const pending: Array<{
      _id: string;
      subscriptionId: string;
      deliveryId: string;
      loadId: string;
      eventType: string;
      positionsFrom?: number;
      positionsTo?: number;
      attempts: number;
      maxAttempts: number;
    }> = await ctx.runQuery(internal.externalTrackingWebhooks.getPendingDeliveries, {});

    for (const delivery of pending) {
      // Get subscription details
      const sub = await ctx.runQuery(internal.externalTrackingWebhooks.getSubscriptionById, {
        subscriptionId: delivery.subscriptionId as Id<'webhookSubscriptions'>,
      });

      if (!sub || sub.status !== 'ACTIVE') {
        await ctx.runMutation(internal.externalTrackingWebhooks.markDeliveryFailed, {
          deliveryId: delivery._id as Id<'webhookDeliveryQueue'>,
          httpStatus: 0,
          errorMessage: 'Subscription no longer active',
        });
        continue;
      }

      // Build payload
      let positions: any[] = [];
      if (delivery.eventType === 'position.update' && delivery.positionsFrom) {
        const result = await ctx.runQuery(internal.externalTracking.getPositions, {
          loadId: delivery.loadId,
          isSandbox: false,
          since: delivery.positionsFrom,
          until: delivery.positionsTo,
          limit: sub.batchSize ?? 100,
        });
        positions = result.positions;
      }

      // Get load info for the payload
      const load = await ctx.runQuery(internal.externalTracking.resolveLoad, {
        ref: delivery.loadId,
        workosOrgId: sub.workosOrgId,
        environment: 'production',
      });

      const payload = {
        deliveryId: delivery.deliveryId,
        event: delivery.eventType,
        deliveredAt: new Date().toISOString(),
        data: {
          loadRef: load?.internalId || 'unknown',
          externalLoadId: load?.externalLoadId,
          trackingStatus: load?.trackingStatus || 'unknown',
          positions,
        },
      };

      const bodyString = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();

      // Sign the payload
      const signature = await ctx.runAction(internal.externalTrackingAuthCrypto.signWebhookPayload, {
        encryptedSecret: sub.encryptedSecret,
        timestamp,
        body: bodyString,
      });

      // Deliver
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

        const response = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Otoqa-Signature': signature,
            'X-Otoqa-Delivery-Id': delivery.deliveryId,
            'User-Agent': 'Otoqa-Webhooks/1.0',
          },
          body: bodyString,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          await ctx.runMutation(internal.externalTrackingWebhooks.markDeliverySuccess, {
            deliveryId: delivery._id as Id<'webhookDeliveryQueue'>,
            httpStatus: response.status,
            subscriptionId: delivery.subscriptionId as Id<'webhookSubscriptions'>,
          });
        } else {
          await ctx.runMutation(internal.externalTrackingWebhooks.markDeliveryFailed, {
            deliveryId: delivery._id as Id<'webhookDeliveryQueue'>,
            httpStatus: response.status,
            errorMessage: `HTTP ${response.status}: ${response.statusText}`,
          });
        }
      } catch (error: any) {
        await ctx.runMutation(internal.externalTrackingWebhooks.markDeliveryFailed, {
          deliveryId: delivery._id as Id<'webhookDeliveryQueue'>,
          httpStatus: 0,
          errorMessage: error.message || 'Network error',
        });
      }
    }

    return null;
  },
});

export const getPendingDeliveries = internalQuery({
  args: {},
  returns: v.array(v.object({
    _id: v.id('webhookDeliveryQueue'),
    subscriptionId: v.id('webhookSubscriptions'),
    deliveryId: v.string(),
    loadId: v.id('loadInformation'),
    eventType: v.string(),
    positionsFrom: v.optional(v.number()),
    positionsTo: v.optional(v.number()),
    attempts: v.number(),
    maxAttempts: v.number(),
  })),
  handler: async (ctx) => {
    const now = Date.now();
    const items = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) =>
        q.eq('status', 'PENDING').lte('nextAttemptAt', now)
      )
      .take(50);

    return items.map((i) => ({
      _id: i._id,
      subscriptionId: i.subscriptionId,
      deliveryId: i.deliveryId,
      loadId: i.loadId,
      eventType: i.eventType,
      positionsFrom: i.positionsFrom,
      positionsTo: i.positionsTo,
      attempts: i.attempts,
      maxAttempts: i.maxAttempts,
    }));
  },
});

export const getSubscriptionById = internalQuery({
  args: { subscriptionId: v.id('webhookSubscriptions') },
  returns: v.union(
    v.object({
      url: v.string(),
      encryptedSecret: v.string(),
      status: v.string(),
      workosOrgId: v.string(),
      batchSize: v.optional(v.number()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const sub = await ctx.db.get(args.subscriptionId);
    if (!sub) return null;
    return {
      url: sub.url,
      encryptedSecret: sub.encryptedSecret,
      status: sub.status,
      workosOrgId: sub.workosOrgId,
      batchSize: sub.batchSize,
    };
  },
});

export const markDeliverySuccess = internalMutation({
  args: {
    deliveryId: v.id('webhookDeliveryQueue'),
    httpStatus: v.number(),
    subscriptionId: v.id('webhookSubscriptions'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: 'DELIVERED',
      lastHttpStatus: args.httpStatus,
      deliveredAt: Date.now(),
      attempts: (await ctx.db.get(args.deliveryId))!.attempts + 1,
    });

    // Reset consecutive failures on success
    await ctx.db.patch(args.subscriptionId, {
      consecutiveFailures: 0,
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const markDeliveryFailed = internalMutation({
  args: {
    deliveryId: v.id('webhookDeliveryQueue'),
    httpStatus: v.number(),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return null;

    const newAttempts = delivery.attempts + 1;
    const isDead = newAttempts >= delivery.maxAttempts;

    // Exponential backoff with jitter: min(60 * 2^attempt + jitter, 3600) seconds
    const baseDelay = 60_000; // 1 minute in ms
    const maxDelay = 3600_000; // 1 hour in ms
    const jitter = Math.random() * 30_000; // 0-30s jitter
    const delay = Math.min(baseDelay * Math.pow(2, newAttempts) + jitter, maxDelay);

    await ctx.db.patch(args.deliveryId, {
      status: isDead ? 'DEAD_LETTER' : 'PENDING',
      attempts: newAttempts,
      lastHttpStatus: args.httpStatus,
      lastErrorMessage: args.errorMessage,
      nextAttemptAt: isDead ? undefined : Date.now() + delay,
    });

    // Increment consecutive failures on subscription
    const sub = await ctx.db.get(delivery.subscriptionId);
    if (sub) {
      const newFailures = sub.consecutiveFailures + 1;
      const updates: any = {
        consecutiveFailures: newFailures,
        lastFailureReason: args.errorMessage,
        updatedAt: Date.now(),
      };

      // Auto-disable after 50 consecutive failures
      if (newFailures >= 50) {
        updates.status = 'DISABLED';
      }

      await ctx.db.patch(delivery.subscriptionId, updates);
    }

    return null;
  },
});
