import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { assertCallerOwnsOrg } from "./lib/auth";

/**
 * Count loads, stops, and invoices for an organization
 */
export const countLoadsAndStops = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Count loads
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    // Count stops
    const stops = await ctx.db
      .query("loadStops")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    // Count invoices
    const invoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();
    
    const invoicesByStatus = {
      MISSING_DATA: invoices.filter((i) => i.status === "MISSING_DATA").length,
      DRAFT: invoices.filter((i) => i.status === "DRAFT").length,
      BILLED: invoices.filter((i) => i.status === "BILLED").length,
      PAID: invoices.filter((i) => i.status === "PAID").length,
    };

    // Get FourKites loads
    const fourKitesLoads = loads.filter((l) => l.externalSource === "FourKites");

    // Get sample load with its stops
    const sampleLoad = fourKitesLoads[0];
    let sampleStops = [];
    if (sampleLoad) {
      sampleStops = await ctx.db
        .query("loadStops")
        .withIndex("by_load", (q) => q.eq("loadId", sampleLoad._id))
        .collect();
    }

    return {
      totalLoads: loads.length,
      fourKitesLoads: fourKitesLoads.length,
      totalStops: stops.length,
      totalInvoices: invoices.length,
      invoicesByStatus,
      sampleLoad: sampleLoad
        ? {
            _id: sampleLoad._id,
            internalId: sampleLoad.internalId,
            orderNumber: sampleLoad.orderNumber,
            externalLoadId: sampleLoad.externalLoadId,
            stopCount: sampleStops.length,
          }
        : null,
    };
  },
});

/**
 * Diagnose ping attribution for one or more loads by internalId.
 *
 * For each internalId, returns:
 *   - load._id, workosOrgId, status, timestamps
 *   - ping count via by_load index
 *   - distinct sessionIds found among those pings
 *   - time range (min/max recordedAt) and loadId distribution
 *
 * Also returns the "session overlap" view: for every sessionId that
 * appears in any of the requested loads, the full breakdown of how
 * that session's pings are attributed across loadIds (including null).
 *
 * Purpose: debug the reported "two loads appear to share the same
 * GPS pings" issue. Run via:
 *   npx convex run diagnostics:diagnoseLoadPings \
 *     '{"internalIds": ["106890568", "107032119"]}'
 */
/**
 * Look up a driver by Clerk userId so we can find their active session and
 * workosOrgId without having to scrape Convex dashboards.
 */
export const findDriverByClerkId = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("userIdentityLinks")
      .withIndex("by_clerk", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (!link) return { reason: "no identity link for clerkUserId" };

    const driver = link.phone
      ? await ctx.db
          .query("drivers")
          .withIndex("by_phone", (q) => q.eq("phone", link.phone as string))
          .first()
      : null;

    return {
      link: {
        _id: link._id,
        email: link.email ?? null,
        phone: link.phone ?? null,
        workosOrgId: link.workosOrgId ?? null,
      },
      driver: driver
        ? {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            organizationId: driver.organizationId,
          }
        : null,
    };
  },
});

/**
 * Find drivers by (case-insensitive substring match on) first or last name.
 * Returns the driver + their org and any active session. Small table scan,
 * fine for diagnostics.
 */
export const findDriverByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const needle = args.name.toLowerCase();
    const drivers = await ctx.db.query("drivers").take(500);
    const matches = drivers
      .filter(
        (d) =>
          d.firstName.toLowerCase().includes(needle) ||
          d.lastName.toLowerCase().includes(needle)
      )
      .map((d) => ({
        _id: d._id,
        firstName: d.firstName,
        lastName: d.lastName,
        organizationId: d.organizationId,
      }));
    return matches;
  },
});

/**
 * Look up one or more loads by internalId across ALL orgs. Pages through
 * loadInformation so we don't blow the byte budget on big tables.
 */
export const findLoadsByInternalId = internalQuery({
  args: { internalIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    // Convex caps byte reads at 16 MB per function and only allows one
    // paginated query. Instead: take a scrollable slice in one call. If
    // the org has fewer than ~2000 loads (typical for a carrier), this
    // is enough to find the matches.
    const wanted = new Set(args.internalIds);
    const loads = await ctx.db.query("loadInformation").take(2000);
    return loads
      .filter((l) => wanted.has(l.internalId))
      .map((l) => ({
        internalId: l.internalId,
        loadId: l._id,
        workosOrgId: l.workosOrgId,
        status: (l.status as string | undefined) ?? null,
      }));
  },
});

/**
 * All dispatchLegs for a driver, newest first, resolving each to its load
 * (internalId + workosOrgId). Scoped diagnostic.
 */
export const findDriverRecentLegs = internalQuery({
  args: { driverId: v.id("drivers"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const legs = await ctx.db
      .query("dispatchLegs")
      .filter((q) => q.eq(q.field("driverId"), args.driverId))
      .order("desc")
      .take(args.limit ?? 10);

    return Promise.all(
      legs.map(async (leg) => {
        const load = leg.loadId ? await ctx.db.get(leg.loadId) : null;
        return {
          legId: leg._id,
          status: leg.status,
          startedAt: leg.startedAt ?? null,
          endedAt: leg.endedAt ?? null,
          sessionId: leg.sessionId ?? null,
          loadId: leg.loadId,
          loadInternalId: load?.internalId ?? null,
          loadWorkosOrgId: load?.workosOrgId ?? null,
          loadStatus: (load?.status as string | undefined) ?? null,
        };
      })
    );
  },
});

/**
 * For each of the given loads, return stops + check-in/out times +
 * dispatchLegs, plus a chronological interleaving of pings across all
 * loads so we can see which loadId was active at every moment. Limits
 * to 400 pings per load to keep the byte budget happy.
 */
export const diagnoseLoadTimeline = internalQuery({
  args: {
    internalIds: v.array(v.string()),
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const loads: Array<{
      internalId: string;
      loadId: string;
      status: string | null;
      stops: Array<{
        sequence: number;
        type: string;
        status: string | null;
        checkedInAt: number | null;
        checkedOutAt: number | null;
        city: string | null;
        state: string | null;
      }>;
      legs: Array<{
        status: string;
        startedAt: number | null;
        endedAt: number | null;
        sessionId: string | null;
      }>;
    }> = [];

    const mergedPings: Array<{
      recordedAt: number;
      loadId: string;
      sessionId: string | null;
      _id: string;
    }> = [];

    for (const internalId of args.internalIds) {
      const load = await ctx.db
        .query("loadInformation")
        .withIndex("by_internal_id", (q) =>
          q.eq("workosOrgId", args.workosOrgId).eq("internalId", internalId)
        )
        .first();
      if (!load) continue;

      const stops = await ctx.db
        .query("loadStops")
        .withIndex("by_load", (q) => q.eq("loadId", load._id))
        .collect();

      const legs = await ctx.db
        .query("dispatchLegs")
        .filter((q) => q.eq(q.field("loadId"), load._id))
        .collect();

      const pings = await ctx.db
        .query("driverLocations")
        .withIndex("by_load", (q) => q.eq("loadId", load._id))
        .take(400);

      for (const p of pings) {
        mergedPings.push({
          recordedAt: p.recordedAt,
          loadId: p.loadId as string,
          sessionId: (p.sessionId as string | undefined) ?? null,
          _id: p._id,
        });
      }

      loads.push({
        internalId: load.internalId,
        loadId: load._id,
        status: (load.status as string | undefined) ?? null,
        stops: stops
          .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
          .map((s) => ({
            sequence: s.sequenceNumber ?? 0,
            type: (s.stopType as string | undefined) ?? "unknown",
            status: (s.status as string | undefined) ?? null,
            checkedInAt:
              typeof (s as any).driverCheckInAt === "number"
                ? (s as any).driverCheckInAt
                : null,
            checkedOutAt:
              typeof (s as any).driverCheckOutAt === "number"
                ? (s as any).driverCheckOutAt
                : null,
            city: (s as any).city ?? null,
            state: (s as any).state ?? null,
          })),
        legs: legs.map((l) => ({
          status: l.status as string,
          startedAt: l.startedAt ?? null,
          endedAt: l.endedAt ?? null,
          sessionId: (l.sessionId as string | undefined) ?? null,
        })),
      });
    }

    mergedPings.sort((a, b) => a.recordedAt - b.recordedAt);

    // Count load-transitions (i.e. consecutive pings that jumped loadId).
    let transitions = 0;
    for (let i = 1; i < mergedPings.length; i++) {
      if (mergedPings[i].loadId !== mergedPings[i - 1].loadId) transitions++;
    }

    return {
      loads,
      interleavedPingCount: mergedPings.length,
      interleavedTransitions: transitions,
      firstTwentyPings: mergedPings.slice(0, 20),
      lastTwentyPings: mergedPings.slice(-20),
    };
  },
});

/**
 * Return every ping for the given loads in a given recordedAt window, with
 * their createdAt (server insert time). Lets us see the batch-insert
 * cadence and confirm whether late-arriving pings are being backfilled.
 */
export const pingsInWindow = internalQuery({
  args: {
    loadIds: v.array(v.id("loadInformation")),
    fromMs: v.number(),
    toMs: v.number(),
  },
  handler: async (ctx, args) => {
    const out: Array<{
      loadId: string;
      recordedAt: number;
      createdAt: number;
      recordedToCreatedGapMs: number;
      sessionId: string | null;
    }> = [];
    for (const loadId of args.loadIds) {
      const pings = await ctx.db
        .query("driverLocations")
        .withIndex("by_load", (q) => q.eq("loadId", loadId))
        .take(3000);
      for (const p of pings) {
        if (p.recordedAt < args.fromMs || p.recordedAt > args.toMs) continue;
        out.push({
          loadId: p.loadId as string,
          recordedAt: p.recordedAt,
          createdAt: p.createdAt,
          recordedToCreatedGapMs: p.createdAt - p.recordedAt,
          sessionId: (p.sessionId as string | undefined) ?? null,
        });
      }
    }
    out.sort((a, b) => a.recordedAt - b.recordedAt);
    return out;
  },
});

/**
 * Bucket the most recent N pings for a session by (loadId, tracking-type).
 * Lets us see if post-OTA pings are arriving with sessionId-only, with
 * loadId+sessionId, or still legacy loadId-only.
 */
export const pingsForSession = internalQuery({
  args: {
    sessionId: v.id("driverSessions"),
    afterMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pings = await ctx.db
      .query("driverLocations")
      .withIndex("by_session_time", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(args.limit ?? 500);

    const filtered = args.afterMs
      ? pings.filter((p) => p.recordedAt >= args.afterMs!)
      : pings;

    const byShape: Record<string, number> = {};
    let minAt: number | null = null;
    let maxAt: number | null = null;
    for (const p of filtered) {
      const shape = p.loadId
        ? `LOAD_ROUTE (loadId=${(p.loadId as string).slice(0, 12)}…)`
        : "SESSION_ROUTE (no loadId)";
      byShape[shape] = (byShape[shape] ?? 0) + 1;
      if (minAt === null || p.recordedAt < minAt) minAt = p.recordedAt;
      if (maxAt === null || p.recordedAt > maxAt) maxAt = p.recordedAt;
    }

    // Also dup-check: recordedAts with >1 ping in the sampled window.
    const byRecordedAt = new Map<number, number>();
    for (const p of filtered) {
      byRecordedAt.set(p.recordedAt, (byRecordedAt.get(p.recordedAt) ?? 0) + 1);
    }
    let duplicates = 0;
    for (const c of byRecordedAt.values()) {
      if (c > 1) duplicates += c - 1;
    }

    return {
      total: filtered.length,
      byShape,
      minRecordedAt: minAt,
      maxRecordedAt: maxAt,
      duplicatePings: duplicates,
      uniqueRecordedAts: byRecordedAt.size,
      sample: filtered.slice(0, 10).map((p) => ({
        _id: p._id,
        loadId: (p.loadId as string | undefined) ?? null,
        trackingType: p.trackingType,
        recordedAt: p.recordedAt,
        createdAt: p.createdAt,
      })),
    };
  },
});

/**
 * Most recent pings for a driver (from the driver's org time index),
 * regardless of loadId or sessionId. Shows whether fresh pings are
 * landing at all, and with what shape.
 */
export const recentPingsForDriver = internalQuery({
  args: {
    driverId: v.id("drivers"),
    workosOrgId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pings = await ctx.db
      .query("driverLocations")
      .withIndex("by_org_time", (q) => q.eq("organizationId", args.workosOrgId))
      .order("desc")
      .take(args.limit ?? 50);
    const mine = pings.filter((p) => p.driverId === args.driverId);
    return mine.map((p) => ({
      _id: p._id,
      recordedAt: p.recordedAt,
      createdAt: p.createdAt,
      loadId: (p.loadId as string | undefined) ?? null,
      sessionId: (p.sessionId as string | undefined) ?? null,
      trackingType: p.trackingType,
    }));
  },
});

export const diagnoseLoadPings = internalQuery({
  args: {
    internalIds: v.array(v.string()),
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const loadReports: Array<{
      internalId: string;
      loadId: string | null;
      workosOrgId: string | null;
      status: string | null;
      createdAt: number | null;
      pingCount: number;
      pingMinRecordedAt: number | null;
      pingMaxRecordedAt: number | null;
      distinctSessionIds: string[];
      distinctDriverIds: string[];
      samplePings: Array<{
        _id: string;
        loadId: string | null;
        sessionId: string | null;
        driverId: string;
        recordedAt: number;
        trackingType: string;
      }>;
    }> = [];

    const sessionIdsSeen = new Set<string>();

    for (const internalId of args.internalIds) {
      const load = await ctx.db
        .query("loadInformation")
        .withIndex("by_internal_id", (q) =>
          q.eq("workosOrgId", args.workosOrgId).eq("internalId", internalId)
        )
        .first();

      if (!load) {
        loadReports.push({
          internalId,
          loadId: null,
          workosOrgId: null,
          status: null,
          createdAt: null,
          pingCount: 0,
          pingMinRecordedAt: null,
          pingMaxRecordedAt: null,
          distinctSessionIds: [],
          distinctDriverIds: [],
          samplePings: [],
        });
        continue;
      }

      // Convex only allows one paginated query per function. Use take()
      // with a ceiling that's large enough for a full load route (~1 ping
      // every 30 s over even a 10-hour shift = ~1200).
      const pings = await ctx.db
        .query("driverLocations")
        .withIndex("by_load", (q) => q.eq("loadId", load._id))
        .take(3000);

      const sessionSet = new Set<string>();
      const driverSet = new Set<string>();
      let minAt: number | null = null;
      let maxAt: number | null = null;
      const firstThree: any[] = [];
      const lastThree: any[] = [];

      for (const p of pings) {
        if (p.sessionId) sessionSet.add(p.sessionId);
        driverSet.add(p.driverId);
        if (minAt === null || p.recordedAt < minAt) minAt = p.recordedAt;
        if (maxAt === null || p.recordedAt > maxAt) maxAt = p.recordedAt;
        if (p.sessionId) sessionIdsSeen.add(p.sessionId);

        const sample = {
          _id: p._id,
          loadId: (p.loadId as string | undefined) ?? null,
          sessionId: (p.sessionId as string | undefined) ?? null,
          driverId: p.driverId as string,
          recordedAt: p.recordedAt,
          trackingType: p.trackingType,
        };
        if (firstThree.length < 3) firstThree.push(sample);
        lastThree.push(sample);
        if (lastThree.length > 3) lastThree.shift();
      }
      const total = pings.length;

      loadReports.push({
        internalId,
        loadId: load._id,
        workosOrgId: load.workosOrgId,
        status: load.status ?? null,
        createdAt: load._creationTime,
        pingCount: total,
        pingMinRecordedAt: minAt,
        pingMaxRecordedAt: maxAt,
        distinctSessionIds: [...sessionSet],
        distinctDriverIds: [...driverSet],
        samplePings: [...firstThree, ...lastThree],
      });
    }

    // Session overlap skipped — driverLocations is large and the byte
    // budget is tight. The loadReports already show distinctSessionIds
    // per load, which is the signal we need for the overlap question.
    return { loads: loadReports, sessions: [] };
  },
});
