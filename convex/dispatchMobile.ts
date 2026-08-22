import { mutation, query, type QueryCtx } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import {
  CAPABILITY_SLUGS,
  getCallerPermissionClaims,
  resolveClerkCarrierMembership,
  type DispatchCapability,
} from './lib/auth';
import { isPermitted } from './lib/permissions';
import { getLoadFacets, findLoadIdsByFacets } from './lib/loadFacets';
import { estimateHos, hosChipLabel, HOS_CYCLE_DAYS, type HosEstimate } from './lib/hos';
import { internal } from './_generated/api';
import { carrierStatementsForOrg, carrierStatementDetailsForOrg } from './mobileSettlements';
import { logAudit } from './lib/audit';
import { raiseAlert } from './dispatchAlerts';
import { createLoadArgs, createLoadForOrg } from './loads';
import type { Doc, Id } from './_generated/dataModel';

// The mobile create-load surface: the web validator set minus the fields
// the server derives from the caller (org + performer identity).
const {
  workosOrgId: _srvOrg,
  createdBy: _srvBy,
  createdByName: _srvByName,
  ...dispatchCreateLoadArgs
} = createLoadArgs;
void _srvOrg; void _srvBy; void _srvByName;

/**
 * Otoqa Dispatch — mobile session bootstrap (split-plan §3.3 / §4.2).
 *
 * One query the Dispatch app calls after sign-in to learn who the caller
 * is and what to render. Serves BOTH auth populations on one Convex
 * deployment:
 *
 *   - WorkOS staff (org claim + RBAC permission claims on the token):
 *     capabilities derive from the claims via the same isPermitted policy
 *     the web uses (admin bypass → legacy grandfathering → strict check).
 *   - Clerk owner-operators (no org claim): membership resolves through
 *     userIdentityLinks (by clerkUserId, then verified phone — the
 *     getUserRoles parity paths), and the persona holds every capability
 *     (decision D9).
 *
 * The app renders from the returned capability flags ONLY — never from
 * "which provider am I". Server-side enforcement lives in
 * requireCapability (lib/auth.ts); this query is the display-side twin.
 *
 * NOTE (§4.4 behavior freeze): this is a NEW endpoint. carrierMobile.
 * getUserRoles is intentionally untouched — old Driver builds keep their
 * exact behavior.
 */

interface DispatchSession {
  authenticated: boolean;
  /** Which auth population the token belongs to (informational only). */
  provider: 'workos' | 'clerk' | null;
  /** External org id (workosOrgId for staff, clerkOrgId/workosOrgId for owner-ops). */
  orgExternalId: string | null;
  /** Convex organizations doc id, when the org doc is known. */
  orgConvexId: string | null;
  orgName: string | null;
  orgType: string | null;
  /** UI label: staff see their RBAC role; all Clerk users are "Owner-operator" (D9). */
  persona: 'staff' | 'owner_operator' | null;
  capabilities: Record<DispatchCapability, boolean>;
}

const NO_SESSION: DispatchSession = {
  authenticated: false,
  provider: null,
  orgExternalId: null,
  orgConvexId: null,
  orgName: null,
  orgType: null,
  persona: null,
  capabilities: {
    canDispatch: false,
    canViewOperations: false,
    canViewFleet: false,
    canViewSettlements: false,
    canManageDrivers: false,
  },
};

export const getSession = query({
  args: {},
  handler: async (ctx): Promise<DispatchSession> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return NO_SESSION;

    const claims = identity as unknown as { org_id?: string; organizationId?: string };
    const claimOrg = claims.org_id ?? claims.organizationId;

    if (claimOrg) {
      // WorkOS staff path. Capabilities from RBAC claims; org doc looked up
      // for display metadata (may be absent for orgs not mirrored yet).
      const permissionClaims = await getCallerPermissionClaims(ctx);
      const capabilities = Object.fromEntries(
        (Object.keys(CAPABILITY_SLUGS) as DispatchCapability[]).map((cap) => [
          cap,
          isPermitted(permissionClaims, CAPABILITY_SLUGS[cap]),
        ]),
      ) as Record<DispatchCapability, boolean>;

      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', claimOrg))
        .first();

      return {
        authenticated: true,
        provider: 'workos',
        orgExternalId: claimOrg,
        orgConvexId: org?._id ?? null,
        orgName: org?.name ?? null,
        orgType: org?.orgType ?? null,
        persona: 'staff',
        capabilities,
      };
    }

    // Clerk path — owner-operator persona or nothing.
    const membership = await resolveClerkCarrierMembership(ctx);
    if (!membership) {
      // Authenticated, but no qualifying carrier membership (e.g. a driver
      // with no owner role, or a MEMBER link). The app shows its
      // "not registered for dispatch" dead-end — fail loud, not empty.
      return { ...NO_SESSION, authenticated: true, provider: 'clerk' };
    }

    return {
      authenticated: true,
      provider: 'clerk',
      // Same fallback chain as resolveOrgForRead: mobile-created carrier
      // orgs may carry neither external id, in which case the Convex doc
      // id IS the org's external id (requireCapability accepts all three).
      orgExternalId: membership.org.clerkOrgId ?? membership.org.workosOrgId ?? membership.org._id,
      orgConvexId: membership.org._id,
      orgName: membership.org.name,
      orgType: membership.org.orgType ?? null,
      persona: 'owner_operator',
      capabilities: {
        canDispatch: true,
        canViewOperations: true,
        canViewFleet: true,
        canViewSettlements: true,
        canManageDrivers: true,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// Read wrappers (split-plan §4.5) — the Dispatch app's data layer.
//
// FAIL-LOUD by design: the legacy carrierMobile reads authenticate via
// requireCarrierAuth (Clerk-only, returns []) — a WorkOS staff caller
// would see silently empty screens. Every read here resolves the org
// from the token dual-path and THROWS on any auth/capability miss.
// Args carry no org id: the org always derives from the caller.
//
// The legacy endpoints stay byte-identical for shipped Driver builds
// (§4.4 behavior freeze); these are new endpoints, free to be lean.
// Scoping mirrors the originals:
//   - loadCarrierAssignments.by_carrier keys on the EXTERNAL org id
//   - drivers.by_organization stores the org Convex id for
//     mobile-created carrier orgs and the workosOrgId for web-created
//     ones — so driver reads query BOTH and merge.
// ─────────────────────────────────────────────────────────────────────

interface ResolvedOrg {
  org: Doc<'organizations'>;
  /** Id used by loadCarrierAssignments.carrierOrgId. */
  externalId: string;
  /** Every id drivers.organizationId might carry for this org. */
  driverOrgIds: string[];
}

/** Dual-path org + capability resolution. Throws on every miss. */
export async function resolveOrgForRead(
  ctx: QueryCtx,
  capability: DispatchCapability,
): Promise<ResolvedOrg> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError('Unauthenticated');

  const claims = identity as unknown as { org_id?: string; organizationId?: string };
  const claimOrg = claims.org_id ?? claims.organizationId;

  if (claimOrg) {
    const permissionClaims = await getCallerPermissionClaims(ctx);
    if (!isPermitted(permissionClaims, CAPABILITY_SLUGS[capability])) {
      throw new ConvexError(`Not authorized: missing ${capability}`);
    }
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', claimOrg))
      .first();
    if (!org || org.isDeleted) throw new ConvexError('Organization not provisioned for dispatch');
    return {
      org,
      externalId: org.clerkOrgId ?? claimOrg,
      driverOrgIds: [org._id as string, claimOrg],
    };
  }

  const membership = await resolveClerkCarrierMembership(ctx);
  if (!membership) throw new ConvexError(`Not authorized: missing ${capability}`);
  const org = membership.org as Doc<'organizations'>;
  return {
    org,
    externalId: (org.clerkOrgId ?? org.workosOrgId ?? org._id) as string,
    driverOrgIds: [org._id as string, org.workosOrgId].filter(
      (x): x is string => typeof x === 'string',
    ),
  };
}

/** Active + deleted-filtered drivers across both org-id spellings. */
export async function orgDrivers(ctx: QueryCtx, resolved: ResolvedOrg): Promise<Doc<'drivers'>[]> {
  const seen = new Set<string>();
  const out: Doc<'drivers'>[] = [];
  for (const orgId of resolved.driverOrgIds) {
    const rows = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', orgId))
      .collect();
    for (const d of rows) {
      if (seen.has(d._id)) continue;
      seen.add(d._id);
      if (d.employmentStatus === 'Active' && !d.isDeleted) out.push(d);
    }
  }
  return out;
}

async function latestLocation(ctx: QueryCtx, driverId: Id<'drivers'>) {
  return await ctx.db
    .query('driverLocations')
    .withIndex('by_driver_time', (q) => q.eq('driverId', driverId))
    .order('desc')
    .first();
}

/** Session-derived HOS estimate (D11): trailing-8-day sessions via the
 *  by_driver_started index, plus the live session (which may predate the
 *  window). Pure math lives in lib/hos.ts. */
async function hosForDriver(ctx: QueryCtx, driverId: Id<'drivers'>): Promise<HosEstimate> {
  const cutoff = Date.now() - HOS_CYCLE_DAYS * 86_400_000;
  const recent = await ctx.db
    .query('driverSessions')
    .withIndex('by_driver_started', (q) => q.eq('driverId', driverId).gte('startedAt', cutoff))
    .collect();
  const active = await ctx.db
    .query('driverSessions')
    .withIndex('by_driver_status', (q) => q.eq('driverId', driverId).eq('status', 'active'))
    .collect();
  const seen = new Set<string>();
  const sessions = [];
  for (const s of [...recent, ...active]) {
    if (seen.has(s._id as string)) continue;
    seen.add(s._id as string);
    sessions.push({
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      totalActiveMinutes: s.totalActiveMinutes ?? null,
      status: s.status,
    });
  }
  return estimateHos(sessions, Date.now());
}

async function assignmentsByStatus(
  ctx: QueryCtx,
  externalId: string,
  status: 'OFFERED' | 'ACCEPTED' | 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED',
) {
  return await ctx.db
    .query('loadCarrierAssignments')
    .withIndex('by_carrier', (q) => q.eq('carrierOrgId', externalId).eq('status', status))
    .collect();
}

/** Board data — AWARDED + IN_PROGRESS assignments, enriched like
 * getActiveLoads, PLUS web-TMS dispatch legs. Orgs that assign drivers in
 * the web TMS create dispatchLegs, not loadCarrierAssignments — without
 * the merge their Board is empty (same model gap listDriverHistory
 * closes). Leg rows are read-only on the client (source: 'leg'). */
/**
 * Open loads — the web-TMS backlog.
 *
 * The board previously read two sources: brokered carrier assignments, and
 * dispatch legs. A load that is `status: 'Open'` has neither — no broker
 * assignment because nobody brokered it, and no leg because a leg is what
 * dispatching one *creates*. So the entire population this app exists to
 * assign was invisible to it, and the horizon tiles read zero while the
 * backlog sat in the TMS.
 *
 * Bounded on purpose, per the design's premise that a phone never shows
 * "all unassigned": a date window off the by_org_status_first_stop index,
 * plus a hard cap. `truncated` tells the client the tiles are a floor
 * rather than a total, so a big backlog never renders as a small one.
 */
const OPEN_BACKLOG_CAP = 200;
const OPEN_BACKLOG_DAYS_BACK = 1;
const OPEN_BACKLOG_DAYS_FORWARD = 14;

const dateKey = (ms: number) => new Date(ms).toISOString().split('T')[0];

async function openBacklog(ctx: QueryCtx, resolved: ResolvedOrg, now: number) {
  const from = dateKey(now - OPEN_BACKLOG_DAYS_BACK * 86_400_000);
  const to = dateKey(now + OPEN_BACKLOG_DAYS_FORWARD * 86_400_000);
  const orgScopes = [...new Set([...resolved.driverOrgIds, resolved.externalId])];

  const loads: Doc<'loadInformation'>[] = [];
  for (const orgId of orgScopes) {
    loads.push(
      ...(await ctx.db
        .query('loadInformation')
        .withIndex('by_org_status_first_stop', (q) =>
          q.eq('workosOrgId', orgId).eq('status', 'Open').gte('firstStopDate', from).lte('firstStopDate', to),
        )
        .take(OPEN_BACKLOG_CAP + 1)),
    );
  }

  // A load that already has a leg is dispatched, whatever its status says —
  // it must not appear twice on one board.
  const legged = new Set<string>();
  for (const orgId of orgScopes) {
    for (const status of ['PENDING', 'ACTIVE'] as const) {
      for (const leg of await ctx.db
        .query('dispatchLegs')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', orgId).eq('status', status))
        .collect()) {
        legged.add(leg.loadId as string);
      }
    }
  }

  const seen = new Set<string>();
  const fresh = loads.filter((l) => {
    const key = l._id as string;
    if (legged.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  fresh.sort((a, b) => (a.firstStopDate ?? '').localeCompare(b.firstStopDate ?? ''));

  return {
    loads: fresh.slice(0, OPEN_BACKLOG_CAP),
    truncated: fresh.length > OPEN_BACKLOG_CAP,
  };
}

export const listActiveAssignments = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const assignments = [
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'AWARDED')),
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS')),
    ];

    const assignmentRows = await Promise.all(
      assignments.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        const stops = load
          ? await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect()
          : [];
        const driver = assignment.assignedDriverId
          ? await ctx.db.get(assignment.assignedDriverId)
          : null;
        const driverLocation = assignment.assignedDriverId
          ? await latestLocation(ctx, assignment.assignedDriverId)
          : null;
        const facets = load
          ? await getLoadFacets(ctx, load._id)
          : { hcr: undefined, trip: undefined, all: [] };
        return {
          ...assignment,
          source: 'assignment' as const,
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                customerName: load.customerName,
                trackingStatus: load.trackingStatus,
                effectiveMiles: load.effectiveMiles,
                equipmentType: load.equipmentType,
                tripNumber: facets.trip,
                hcr: facets.hcr,
                facets: facets.all,
              }
            : null,
          stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
          driver: driver
            ? { _id: driver._id, firstName: driver.firstName, lastName: driver.lastName, phone: driver.phone }
            : null,
          driverLocation,
        };
      }),
    );

    // ── Web-TMS legs ──────────────────────────────────────────────────
    const seenLoads = new Set<string>(assignments.map((a) => a.loadId as string));
    const orgScopes = [...new Set([...resolved.driverOrgIds, resolved.externalId])];
    const legs: Doc<'dispatchLegs'>[] = [];
    for (const orgId of orgScopes) {
      for (const status of ['PENDING', 'ACTIVE'] as const) {
        legs.push(
          ...(await ctx.db
            .query('dispatchLegs')
            .withIndex('by_org_status', (q) => q.eq('workosOrgId', orgId).eq('status', status))
            .collect()),
        );
      }
    }
    const now = Date.now();
    const horizonLo = now - 12 * 3600_000;
    const horizonHi = now + 48 * 3600_000;
    const legRows = [];
    for (const leg of legs) {
      if (seenLoads.has(leg.loadId as string)) continue;
      // ACTIVE always shows; PENDING only inside the board horizon (legs
      // without a denormalized schedule ride along — rare backfill gap).
      if (
        leg.status === 'PENDING' &&
        leg.scheduledStartMs != null &&
        (leg.scheduledStartMs < horizonLo || leg.scheduledStartMs > horizonHi)
      ) {
        continue;
      }
      seenLoads.add(leg.loadId as string);
      const load = await ctx.db.get(leg.loadId);
      const stops = load
        ? await ctx.db
            .query('loadStops')
            .withIndex('by_load', (q) => q.eq('loadId', load._id))
            .collect()
        : [];
      const driver = leg.driverId ? await ctx.db.get(leg.driverId) : null;
      const driverLocation = leg.driverId ? await latestLocation(ctx, leg.driverId) : null;
      const facets = load
        ? await getLoadFacets(ctx, load._id)
        : { hcr: undefined, trip: undefined, all: [] as { key: string; value: string }[] };
      legRows.push({
        _id: leg._id as string,
        source: 'leg' as const,
        status: leg.status === 'ACTIVE' ? ('IN_PROGRESS' as const) : ('AWARDED' as const),
        assignedDriverId: leg.driverId ?? null,
        load: load
          ? {
              _id: load._id,
              internalId: load.internalId,
              customerName: load.customerName,
              trackingStatus: load.trackingStatus,
              effectiveMiles: load.effectiveMiles,
              equipmentType: load.equipmentType,
              tripNumber: facets.trip,
              hcr: facets.hcr,
              facets: facets.all,
            }
          : null,
        stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
        driver: driver
          ? { _id: driver._id, firstName: driver.firstName, lastName: driver.lastName, phone: driver.phone }
          : null,
        driverLocation,
      });
    }

    // Open loads: the web-TMS backlog, which has neither a carrier assignment
    // nor a leg. Shaped like the other rows so the board's bucketing, tiles
    // and assign affordance treat them uniformly.
    const { loads: openLoads, truncated } = await openBacklog(ctx, resolved, now);
    const openRows = await Promise.all(
      openLoads
        .filter((load) => !seenLoads.has(load._id as string))
        .map(async (load) => {
          const stops = await ctx.db
            .query('loadStops')
            .withIndex('by_load', (q) => q.eq('loadId', load._id))
            .collect();
          const facets = await getLoadFacets(ctx, load._id);
          return {
            _id: load._id as unknown as Id<'loadCarrierAssignments'>,
            loadId: load._id,
            source: 'open' as const,
            status: 'AWARDED' as const,
            openBacklogTruncated: truncated,
            load: {
              _id: load._id,
              internalId: load.internalId,
              customerName: load.customerName,
              trackingStatus: load.trackingStatus,
              effectiveMiles: load.effectiveMiles,
              equipmentType: load.equipmentType,
              tripNumber: facets.trip,
              hcr: facets.hcr,
              facets: facets.all,
            },
            stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
            driver: null,
            driverLocation: null,
          };
        }),
    );

    return [...assignmentRows, ...legRows, ...openRows];
  },
});

/** History — COMPLETED assignments, newest first. */
export const listCompletedAssignments = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const completed = await assignmentsByStatus(ctx, resolved.externalId, 'COMPLETED');
    completed.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    const page = completed.slice(0, Math.min(args.limit ?? 50, 200));
    return Promise.all(
      page.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        return {
          ...assignment,
          load: load ? { _id: load._id, internalId: load.internalId, customerName: load.customerName } : null,
        };
      }),
    );
  },
});

/**
 * A driver's loads on one calendar day (voice agent "what loads did X
 * have yesterday", but UI-agnostic). Day bounds come from the CLIENT in
 * epoch ms — dispatch days are local-timezone days and only the device
 * knows its zone.
 *
 * TWO sources, merged and deduped by load — a driver's work is recorded
 * in either depending on which surface assigned it:
 *   1. loadCarrierAssignments.assignedDriverId — the Dispatch app's
 *      assign flow (broker-offered work).
 *   2. dispatchLegs (by_driver) — the web TMS's assignment model, which
 *      is where the driver app's actual trips live. Primary driver
 *      only (team-driver legs index on the primary).
 * A load counts as "on" the day when any stop window, scheduled leg
 * time, or actual start/end/completion event touches it.
 */
export const listDriverHistory = query({
  args: {
    driverId: v.id('drivers'),
    dayStartMs: v.number(),
    dayEndMs: v.number(),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
      throw new ConvexError('Driver not found in your organization');
    }
    const inDay = (t: number | null | undefined) =>
      t != null && t >= args.dayStartMs && t < args.dayEndMs;
    const stopsOf = async (loadId: Id<'loadInformation'>) =>
      (
        await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect()
      ).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const stopTouchesDay = (stops: Doc<'loadStops'>[]) =>
      stops.some((s) => {
        const b = s.windowBeginTime ? Date.parse(s.windowBeginTime) : NaN;
        const e = s.windowEndTime ? Date.parse(s.windowEndTime) : NaN;
        return inDay(Number.isFinite(b) ? b : null) || inDay(Number.isFinite(e) ? e : null);
      });

    const out: {
      _id: string;
      status: 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED';
      completedAt: number | null;
      loadId: string;
      internalId: string | null;
      customerName: string | null;
      tripNumber: string | null;
      hcr: string | null;
      firstStopTime: string | null;
      stopCount: number;
    }[] = [];
    const seenLoads = new Set<string>();

    // Source 1: Dispatch-app assignments.
    const assignments = [
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'AWARDED')),
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS')),
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'COMPLETED')),
    ].filter((a) => a.assignedDriverId === args.driverId);
    for (const assignment of assignments) {
      const stops = await stopsOf(assignment.loadId);
      if (!stopTouchesDay(stops) && !inDay(assignment.completedAt)) continue;
      seenLoads.add(assignment.loadId);
      const load = await ctx.db.get(assignment.loadId);
      const facets: { trip?: string; hcr?: string } = load
        ? await getLoadFacets(ctx, load._id)
        : {};
      out.push({
        _id: assignment._id,
        status: assignment.status as 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED',
        completedAt: assignment.completedAt ?? null,
        loadId: assignment.loadId as string,
        internalId: load?.internalId ?? null,
        customerName: load?.customerName ?? null,
        tripNumber: facets.trip ?? null,
        hcr: facets.hcr ?? null,
        firstStopTime: stops[0]?.windowBeginTime ?? null,
        stopCount: stops.length,
      });
    }

    // Source 2: web-TMS dispatch legs (the driver app's trip records).
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();
    const orgScopes = new Set<string>([...resolved.driverOrgIds, resolved.externalId]);
    for (const leg of legs) {
      if (leg.status === 'CANCELED') continue;
      if (!orgScopes.has(leg.workosOrgId)) continue;
      if (seenLoads.has(leg.loadId)) continue;
      // Denormalized schedule + actual event times first; stop windows
      // as the fallback for historical rows predating the backfill.
      let stops: Doc<'loadStops'>[] | null = null;
      let touches =
        inDay(leg.scheduledStartMs) ||
        inDay(leg.scheduledEndMs) ||
        inDay(leg.startedAt) ||
        inDay(leg.endedAt);
      if (!touches) {
        stops = await stopsOf(leg.loadId);
        touches = stopTouchesDay(stops);
      }
      if (!touches) continue;
      seenLoads.add(leg.loadId);
      stops ??= await stopsOf(leg.loadId);
      const load = await ctx.db.get(leg.loadId);
      const facets: { trip?: string; hcr?: string } = load
        ? await getLoadFacets(ctx, load._id)
        : {};
      out.push({
        _id: leg._id,
        status:
          leg.status === 'ACTIVE' ? 'IN_PROGRESS' : leg.status === 'PENDING' ? 'AWARDED' : 'COMPLETED',
        completedAt: leg.endedAt ?? null,
        loadId: leg.loadId as string,
        internalId: load?.internalId ?? null,
        customerName: load?.customerName ?? null,
        tripNumber: facets.trip ?? null,
        hcr: facets.hcr ?? null,
        firstStopTime: stops[0]?.windowBeginTime ?? null,
        stopCount: stops.length,
      });
    }

    out.sort((a, b) => (a.firstStopTime ?? '').localeCompare(b.firstStopTime ?? ''));
    return out;
  },
});

/**
 * Offer inbox (split-plan §5, Phase 3 accept/decline) — OFFERED rows are
 * actionable; ACCEPTED rows ride along so a responded offer shows as
 * "awaiting broker award" instead of vanishing. Newest first. Enriched
 * like the board rows minus driver fields (offers have no driver yet).
 */
export const listOffers = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const offers = [
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'OFFERED')),
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'ACCEPTED')),
    ];
    offers.sort((a, b) => (b.offeredAt ?? 0) - (a.offeredAt ?? 0));
    return Promise.all(
      offers.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        const stops = load
          ? await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect()
          : [];
        const facets = load ? await getLoadFacets(ctx, load._id) : { hcr: undefined, trip: undefined };
        return {
          ...assignment,
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                customerName: load.customerName,
                equipmentType: load.equipmentType,
                effectiveMiles: load.effectiveMiles,
                tripNumber: facets.trip ?? null,
                hcr: facets.hcr ?? null,
              }
            : null,
          stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
        };
      }),
    );
  },
});

/**
 * Accept a broker's load offer. Same transition semantics as the legacy
 * loadCarrierAssignments.acceptOffer (parity-tested) with the Dispatch-app
 * guard shape: org derives from the token via resolveOrgForRead — the
 * client never supplies an org id (§4.5).
 */
export const acceptOffer = mutation({
  args: { assignmentId: v.id('loadCarrierAssignments') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new ConvexError('Offer not found');
    }
    if (assignment.status !== 'OFFERED') {
      throw new ConvexError(`Cannot accept assignment with status: ${assignment.status}`);
    }
    await ctx.db.patch(args.assignmentId, {
      status: 'ACCEPTED',
      acceptedAt: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Decline a broker's load offer. Mirrors loadCarrierAssignments.declineOffer
 * (parity-tested), including the §5.2 OFFER_DECLINED alert so every
 * dispatcher on the org sees the load fell back to the broker.
 */
export const declineOffer = mutation({
  args: { assignmentId: v.id('loadCarrierAssignments') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new ConvexError('Offer not found');
    }
    if (assignment.status !== 'OFFERED') {
      throw new ConvexError(`Cannot decline assignment with status: ${assignment.status}`);
    }
    await ctx.db.patch(args.assignmentId, { status: 'DECLINED' });
    await raiseAlert(ctx, {
      orgExternalId: assignment.carrierOrgId,
      kind: 'OFFER_DECLINED',
      severity: 'med',
      assignmentId: args.assignmentId,
      loadId: assignment.loadId,
      detail: 'Offer declined — load needs a new assignment.',
    });
    return { success: true };
  },
});

/**
 * Fleet list (v8 design, `lib-dispatch/drivers.jsx`). Beyond the name and
 * phone the old version returned, each row now carries what the design's
 * DriverRow actually renders: a data-backed status, the truck, the route
 * they're running, an HOS estimate and today's leg count.
 *
 * Legs are fetched once per org scope and grouped in memory rather than
 * queried per driver — the per-driver fan-out is already 3 reads (location
 * + the two HOS session queries), and this list renders the whole fleet.
 */
const STALE_FIX_MS = 30 * 60_000;
const LATE_GRACE_MS = 15 * 60_000;

export type DriverListStatus = 'moving' | 'idle' | 'late' | 'offline';

/**
 * Every state is a checkable condition, never a guess:
 *   offline — rolling, but the GPS went quiet (this is "tracking lost")
 *   moving  — rolling with a fresh fix
 *   late    — should have started a leg by now and hasn't
 *   idle    — nothing active: genuinely available
 */
function driverStatus(
  hasActiveLeg: boolean,
  lastFixAt: number | null,
  earliestPendingStartMs: number | null,
  now: number,
): DriverListStatus {
  if (hasActiveLeg) {
    if (lastFixAt == null || now - lastFixAt > STALE_FIX_MS) return 'offline';
    return 'moving';
  }
  if (earliestPendingStartMs != null && earliestPendingStartMs < now - LATE_GRACE_MS) return 'late';
  return 'idle';
}

export const listDrivers = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewFleet');
    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');

    // One pass for the org's open legs, then group by driver.
    const orgScopes = [...new Set([...resolved.driverOrgIds, resolved.externalId])];
    const openLegs: Doc<'dispatchLegs'>[] = [];
    for (const orgId of orgScopes) {
      for (const status of ['PENDING', 'ACTIVE'] as const) {
        openLegs.push(
          ...(await ctx.db
            .query('dispatchLegs')
            .withIndex('by_org_status', (q) => q.eq('workosOrgId', orgId).eq('status', status))
            .collect()),
        );
      }
    }
    const legsByDriver = new Map<string, Doc<'dispatchLegs'>[]>();
    for (const leg of openLegs) {
      if (!leg.driverId) continue;
      const key = leg.driverId as string;
      const list = legsByDriver.get(key);
      if (list) list.push(leg);
      else legsByDriver.set(key, [leg]);
    }

    const now = Date.now();
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;

    // Trucks and stops repeat across drivers/legs — read each at most once.
    const truckCache = new Map<string, string | null>();
    const truckUnit = async (truckId: Id<'trucks'> | undefined) => {
      if (!truckId) return null;
      const key = truckId as string;
      if (truckCache.has(key)) return truckCache.get(key)!;
      const truck = await ctx.db.get(truckId);
      const unit = truck?.unitId ?? null;
      truckCache.set(key, unit);
      return unit;
    };
    const cityOf = async (stopId: Id<'loadStops'>) => {
      const stop = await ctx.db.get(stopId);
      return stop?.city ?? stop?.state ?? null;
    };

    return await Promise.all(
      drivers.map(async (driver) => {
        const legs = legsByDriver.get(driver._id as string) ?? [];
        const activeLeg = legs.find((l) => l.status === 'ACTIVE') ?? null;
        const pendingStarts = legs
          .filter((l) => l.status === 'PENDING' && l.scheduledStartMs != null)
          .map((l) => l.scheduledStartMs!)
          .sort((a, b) => a - b);
        // Both work models are live (see listActiveAssignments, which merges
        // the same two): web-TMS legs, and carrier assignments for the Clerk
        // owner-operator path. A driver rolling on an assignment is rolling.
        const activeAssignment =
          inProgress.find((a) => a.assignedDriverId === driver._id) ?? null;
        const onActiveWork = !!activeLeg || !!activeAssignment;

        const location = await latestLocation(ctx, driver._id);
        const lastFixAt = location?.recordedAt ?? null;
        const status = driverStatus(onActiveWork, lastFixAt, pendingStarts[0] ?? null, now);

        // The route the design puts under the name — only knowable while
        // work is running. Idle drivers have no route line (GPS gives us
        // coordinates, not a city; there is no reverse geocode here).
        let route: { from: string | null; to: string | null } | null = null;
        let currentLoad: { _id: Id<'loadInformation'>; internalId: string } | null = null;
        if (activeLeg) {
          const [from, to] = await Promise.all([
            cityOf(activeLeg.startStopId),
            cityOf(activeLeg.endStopId),
          ]);
          route = { from, to };
          const load = await ctx.db.get(activeLeg.loadId);
          if (load) currentLoad = { _id: load._id, internalId: load.internalId };
        } else if (activeAssignment) {
          const load = await ctx.db.get(activeAssignment.loadId);
          if (load) {
            currentLoad = { _id: load._id, internalId: load.internalId };
            const stops = await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect();
            const ordered = stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            if (ordered.length > 0) {
              const first = ordered[0];
              const last = ordered[ordered.length - 1];
              route = {
                from: first.city ?? first.state ?? null,
                to: last.city ?? last.state ?? null,
              };
            }
          }
        }

        const hos = await hosForDriver(ctx, driver._id);

        return {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          employmentStatus: driver.employmentStatus,
          currentTruckId: driver.currentTruckId,
          truckUnitId: await truckUnit(activeLeg?.truckId ?? driver.currentTruckId),
          status,
          route,
          currentLoad,
          /**
           * What's on their plate today, not a completed count: legs scheduled
           * to start today, plus an in-progress carrier assignment when no leg
           * already represents it (the two models don't overlap per driver).
           */
          loadsToday:
            legs.filter(
              (l) =>
                l.scheduledStartMs != null &&
                l.scheduledStartMs >= dayStart &&
                l.scheduledStartMs < dayEnd,
            ).length + (!activeLeg && activeAssignment ? 1 : 0),
          hos,
          hosLabel: hosChipLabel(hos),
          lastFixAt,
          lastLocation: location,
        };
      }),
    );
  },
});

/** Assign-sheet candidates — active drivers with no in-progress load. */
export const listAvailableDrivers = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewFleet');
    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');
    const busy = new Set(
      inProgress.filter((a) => a.assignedDriverId).map((a) => String(a.assignedDriverId)),
    );
    return drivers
      .filter((d) => !busy.has(String(d._id)))
      .map((d) => ({
        _id: d._id,
        firstName: d.firstName,
        lastName: d.lastName,
        phone: d.phone,
        currentTruckId: d.currentTruckId,
      }));
  },
});

/** Live map — drivers pinged within 24h + their in-progress load (mirrors getDriverLocations). */
export const listDriverLocations = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewFleet');
    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const out = [];
    for (const driver of drivers) {
      const lastLocation = await latestLocation(ctx, driver._id);
      if (!lastLocation || lastLocation.recordedAt < oneDayAgo) continue;
      const currentAssignment = inProgress.find((a) => a.assignedDriverId === driver._id) ?? null;
      const load = currentAssignment ? await ctx.db.get(currentAssignment.loadId) : null;
      out.push({
        driver: {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
        },
        location: lastLocation,
        load: load ? { _id: load._id, internalId: load.internalId, trackingStatus: load.trackingStatus } : null,
      });
    }
    return out;
  },
});

// ─── Settlements (owner-operators + staff with accounting:view, D9) ───

/** Statement list for the caller's org — gated on canViewSettlements. */
export const listStatements = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewSettlements');
    return carrierStatementsForOrg(ctx, resolved.org);
  },
});

/** One itemized statement — same gate, same shared logic as the legacy query. */
export const getStatementDetails = query({
  args: {
    settlementId: v.string(),
    source: v.union(v.literal('legacy'), v.literal('ledger')),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewSettlements');
    return carrierStatementDetailsForOrg(ctx, resolved.org, args.settlementId, args.source);
  },
});

// ─── Ranked assignment (split-plan §5.1) ───

const EARTH_MI = 3958.8;
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_MI * Math.asin(Math.sqrt(h)));
}

/**
 * The §5.1 candidate-scoring core, shared by suggestDriversForLoad and
 * suggestPlan: proximity to an origin point, current workload, ping
 * freshness. Blocked/warned candidates are RANKED WITH WARNINGS, never
 * hidden (v8 design). No HOS chip yet (D11); equipment scoring arrives
 * with the D12 endorsement fields.
 */
async function rankDriversForOrigin(
  ctx: QueryCtx,
  resolved: ResolvedOrg,
  origin: { lat: number; lng: number } | null,
  excludeDriverId?: Id<'drivers'>,
) {
  const drivers = await orgDrivers(ctx, resolved);
  const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');
  const staleCutoff = Date.now() - 45 * 60 * 1000;

  const candidates = await Promise.all(
    drivers
      .filter((d) => d._id !== excludeDriverId)
      .map(async (d) => {
        const loc = await latestLocation(ctx, d._id);
        const activeCount = inProgress.filter((a) => a.assignedDriverId === d._id).length;
        const mi =
          origin && loc ? milesBetween(loc.latitude, loc.longitude, origin.lat, origin.lng) : null;
        const hos = await hosForDriver(ctx, d._id);
        const warns: string[] = [];
        if (activeCount > 0) warns.push(`On ${activeCount} active load${activeCount > 1 ? 's' : ''}`);
        if (!loc) warns.push('No GPS data');
        else if (loc.recordedAt < staleCutoff) warns.push('Ping older than 45 min');
        if (mi != null && mi > 60) warns.push(`${mi} mi deadhead`);
        // HOS estimate warnings (D11) — ranked with warnings, never hidden.
        if (hos.onShift && hos.windowRemainingHours != null && hos.windowRemainingHours < 3) {
          warns.push(`~${hos.windowRemainingHours}h left in 14h window (est)`);
        }
        if (hos.cycleRemainingHours < 5) {
          warns.push(`~${hos.cycleRemainingHours}h left in 70h cycle (est)`);
        }
        let score = 100 + (activeCount === 0 ? 22 : -7 * activeCount);
        if (mi != null) score -= mi * 0.9;
        if (!loc) score -= 25;
        else if (loc.recordedAt < staleCutoff) score -= 15;
        if (hos.onShift && hos.windowRemainingHours != null && hos.windowRemainingHours < 3) score -= 12;
        if (hos.cycleRemainingHours < 5) score -= 12;
        return {
          _id: d._id,
          firstName: d.firstName,
          lastName: d.lastName,
          phone: d.phone,
          milesFromPickup: mi,
          activeLoads: activeCount,
          lastPingAt: loc?.recordedAt ?? null,
          hos,
          hosLabel: hosChipLabel(hos),
          warns,
          score,
        };
      }),
  );
  return candidates.sort((a, b) => b.score - a.score);
}

/** Ranked driver suggestions for one assignment (split-plan §5.1). */
export const suggestDriversForLoad = query({
  args: { assignmentId: v.id('loadCarrierAssignments') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new ConvexError('Assignment not found');
    }
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', assignment.loadId))
      .collect();
    const pickup = stops
      .filter((s) => s.stopType === 'PICKUP')
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
    const origin =
      pickup?.latitude != null && pickup?.longitude != null
        ? { lat: pickup.latitude, lng: pickup.longitude }
        : null;
    return await rankDriversForOrigin(ctx, resolved, origin, assignment.assignedDriverId);
  },
});

/**
 * Dual-path driver assignment for the Dispatch app. The legacy
 * loadCarrierAssignments.assignDriver stays for old builds; its org-claim
 * path can't serve WorkOS staff (assignments key on the CLERK org id).
 * Conflict-aware per §4.6: returns alreadyAssigned instead of clobbering.
 */
/**
 * Ranked candidates for an **open** TMS load — the same scorer
 * suggestDriversForLoad uses, keyed by loadId because an open load has no
 * carrier assignment to key on. Committing is assignDriverToLoadsWeb, which
 * creates the leg that dispatching a load actually means.
 */
export const suggestDriversForOpenLoad = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const load = await ctx.db.get(args.loadId);
    const orgScopes = new Set([...resolved.driverOrgIds, resolved.externalId]);
    if (!load || !orgScopes.has(load.workosOrgId)) {
      throw new ConvexError('Load not found');
    }
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();
    const pickup = stops
      .filter((st) => st.stopType === 'PICKUP')
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
    const origin =
      pickup?.latitude != null && pickup?.longitude != null
        ? { lat: pickup.latitude, lng: pickup.longitude }
        : null;
    return await rankDriversForOrigin(ctx, resolved, origin);
  },
});

export const assignDriverToLoad = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new ConvexError('Assignment not found');
    }
    if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') {
      throw new ConvexError('Can only assign driver to awarded or in-progress loads');
    }
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
      throw new ConvexError('Driver not found in your organization');
    }
    if (assignment.assignedDriverId && assignment.assignedDriverId !== args.driverId) {
      const current = await ctx.db.get(assignment.assignedDriverId);
      return {
        success: false as const,
        alreadyAssigned: {
          driverId: assignment.assignedDriverId,
          driverName: current ? `${current.firstName} ${current.lastName}` : 'another driver',
        },
      };
    }
    await ctx.db.patch(args.assignmentId, {
      assignedDriverId: args.driverId,
      assignedDriverName: `${driver.firstName} ${driver.lastName}`,
      assignedDriverPhone: driver.phone,
    });
    return { success: true as const };
  },
});

// ─────────────────────────────────────────────────────────────────────
// Bundled runs + auto-plan (Phase 3, "§5.1 at scale").
//
// suggestPlan is a PROPOSAL — a pure query over the unassigned AWARDED
// backlog. Nothing commits until the dispatcher reviews it and calls
// applyPlan (deliberately no cron: auto-committing assignments without
// human review is not the v8 design). Deterministic for a given data
// snapshot so convex-test can pin the bundling behavior.
// ─────────────────────────────────────────────────────────────────────

/** Chaining model: average line-haul speed for deadhead drive-time. */
const PLAN_AVG_MPH = 45;
/** Deadhead beyond this never chains — reposition, don't bundle. */
const PLAN_MAX_DEADHEAD_MI = 150;
/** Slack added between a drop and the next pickup (unload + check-out). */
const PLAN_CHAIN_BUFFER_MS = 45 * 60 * 1000;

/**
 * What committing a piece of planned work actually touches.
 *
 * The two backlogs commit differently: a brokered load patches its carrier
 * assignment, an open TMS load gets a dispatch leg created. Carrying the
 * reference on the item lets one planner chain both without the commit path
 * having to guess which it's holding.
 */
export type WorkRef =
  | { kind: 'assignment'; assignmentId: Id<'loadCarrierAssignments'> }
  | { kind: 'load'; loadId: Id<'loadInformation'> };

interface PlanItem {
  ref: WorkRef;
  /** Null for open TMS loads — they have no carrier assignment. */
  assignment: Doc<'loadCarrierAssignments'> | null;
  load: Doc<'loadInformation'> | null;
  facets: { trip?: string; hcr?: string };
  stopCount: number;
  /** First pickup window open / close (close falls back to open). */
  startT: number;
  startCloseT: number;
  /** Last stop window close (falls back to its open). */
  endT: number;
  origin: { lat: number; lng: number } | null;
  dest: { lat: number; lng: number } | null;
  /** Endpoint cities, for the run route line. Display only. */
  originCity: string | null;
  destCity: string | null;
}

const lightLoad = (
  load: Doc<'loadInformation'> | null,
  facets?: { trip?: string; hcr?: string },
) =>
  load
    ? {
        _id: load._id,
        internalId: load.internalId,
        customerName: load.customerName,
        equipmentType: load.equipmentType,
        effectiveMiles: load.effectiveMiles,
        tripNumber: facets?.trip ?? null,
        hcr: facets?.hcr ?? null,
      }
    : null;

/**
 * Propose bundled runs over the unassigned AWARDED backlog.
 *
 * Bundling: loads sorted by pickup-window open (id tiebreak), then greedy
 * chaining — a load joins an existing run when the run's last drop plus
 * buffer plus deadhead drive-time (45 mph) still makes the load's pickup
 * window before it closes, and the deadhead is ≤ 150 mi. Loads missing
 * windows come back in `unplannable` with a reason instead of silently
 * vanishing (§4.5 fail-loud).
 *
 * Ranking: the §5.1 scorer against each run's first pickup; a driver
 * suggested for one run is excluded from later runs in the same plan so
 * the proposal never double-books. Top 3 candidates returned per run —
 * warned candidates ranked, never hidden.
 */
/**
 * Shape the unassigned AWARDED backlog into chainable items.
 *
 * Shared by suggestPlan and boardCapacity so the two can never disagree
 * about what is plannable or where a load starts and ends.
 */
async function shapeBacklog(ctx: QueryCtx, resolved: ResolvedOrg) {
  const now = Date.now();

  /** Windows, endpoints and cities — identical whichever backlog it came from. */
  const shapeOne = async (
    ref: WorkRef,
    loadId: Id<'loadInformation'>,
    assignment: Doc<'loadCarrierAssignments'> | null,
  ) => {
    const load = await ctx.db.get(loadId);
    const facets = load ? await getLoadFacets(ctx, load._id) : {};
    const stops = (
      await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect()
    ).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const pickup = stops.filter((st) => st.stopType === 'PICKUP')[0] ?? stops[0];
    const lastStop = stops[stops.length - 1];
    const startT = pickup?.windowBeginTime ? Date.parse(pickup.windowBeginTime) : NaN;
    const startCloseT = pickup?.windowEndTime ? Date.parse(pickup.windowEndTime) : startT;
    const endT = lastStop?.windowEndTime
      ? Date.parse(lastStop.windowEndTime)
      : lastStop?.windowBeginTime
        ? Date.parse(lastStop.windowBeginTime)
        : NaN;
    if (!Number.isFinite(startT) || !Number.isFinite(endT)) {
      return { ref, assignment, load, facets, reason: 'Missing appointment windows' };
    }
    return {
      ref,
      assignment,
      load,
      facets,
      stopCount: stops.length,
      startT,
      startCloseT: Number.isFinite(startCloseT) ? startCloseT : startT,
      endT,
      origin:
        pickup?.latitude != null && pickup?.longitude != null
          ? { lat: pickup.latitude, lng: pickup.longitude }
          : null,
      dest:
        lastStop?.latitude != null && lastStop?.longitude != null
          ? { lat: lastStop.latitude, lng: lastStop.longitude }
          : null,
      originCity: pickup?.city ?? pickup?.state ?? null,
      destCity: lastStop?.city ?? lastStop?.state ?? null,
    };
  };

  const brokered = (await assignmentsByStatus(ctx, resolved.externalId, 'AWARDED')).filter(
    (a) => !a.assignedDriverId,
  );
  const { loads: openLoads, truncated } = await openBacklog(ctx, resolved, now);

  const shaped = await Promise.all([
    ...brokered.map((a) =>
      shapeOne({ kind: 'assignment', assignmentId: a._id }, a.loadId, a),
    ),
    ...openLoads.map((l) => shapeOne({ kind: 'load', loadId: l._id }, l._id, null)),
  ]);

  const unplannable = shaped
    .filter((x): x is Extract<typeof x, { reason: string }> => 'reason' in x)
    .map((x) => ({
      ref: x.ref,
      assignmentId: x.ref.kind === 'assignment' ? x.ref.assignmentId : null,
      loadId: x.ref.kind === 'load' ? x.ref.loadId : null,
      load: lightLoad(x.load, x.facets),
      reason: x.reason,
    }));

  const plannable = (shaped.filter((x) => !('reason' in x)) as PlanItem[])
    // Past-due work is off the board entirely (see lib/board isActionable), so
    // the planner must not propose it either — suggesting a truck take a
    // pickup whose window closed is worse than staying silent.
    .filter((x) => x.startT >= now)
    .sort((a, b) => a.startT - b.startT || (refKey(a.ref) < refKey(b.ref) ? -1 : 1));

  // The open backlog is capped, so every count derived from it is a floor.
  // Saying so is the difference between "200" and "at least 200".
  return { plannable, unplannable, truncated };
}

/** Stable string for deterministic ordering across both backlogs. */
function refKey(ref: WorkRef): string {
  return ref.kind === 'assignment' ? `a:${ref.assignmentId}` : `l:${ref.loadId}`;
}

/**
 * Greedy chaining onto the first run whose tail can feasibly reach the next
 * pickup. Pure — deterministic for a given snapshot, which is what lets
 * convex-test pin the bundling behavior.
 */
function chainIntoRuns(plannable: PlanItem[]): { items: PlanItem[]; deadheads: number[] }[] {
  const runs: { items: PlanItem[]; deadheads: number[] }[] = [];
  for (const it of plannable) {
    let placed = false;
    for (const run of runs) {
      const tail = run.items[run.items.length - 1];
      if (!tail.dest || !it.origin) continue;
      const deadhead = milesBetween(tail.dest.lat, tail.dest.lng, it.origin.lat, it.origin.lng);
      if (deadhead > PLAN_MAX_DEADHEAD_MI) continue;
      const arrival = tail.endT + PLAN_CHAIN_BUFFER_MS + (deadhead / PLAN_AVG_MPH) * 3600_000;
      if (arrival > it.startCloseT) continue;
      run.items.push(it);
      run.deadheads.push(deadhead);
      placed = true;
      break;
    }
    if (!placed) runs.push({ items: [it], deadheads: [] });
  }
  return runs;
}

export const suggestPlan = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const { plannable, unplannable } = await shapeBacklog(ctx, resolved);
    const runs = chainIntoRuns(plannable);

    // Rank per run; never suggest one driver for two runs in one plan.
    const taken = new Set<string>();
    const proposed = [];
    for (const run of runs) {
      const head = run.items[0];
      const candidates = (await rankDriversForOrigin(ctx, resolved, head.origin)).filter(
        (c) => !taken.has(c._id),
      );
      const top = candidates.slice(0, 3);
      if (top[0]) taken.add(top[0]._id);
      proposed.push({
        loads: run.items.map((it) => ({
          ref: it.ref,
          // Present only for brokered work; open TMS loads carry loadId.
          assignmentId: it.ref.kind === 'assignment' ? it.ref.assignmentId : null,
          loadId: it.ref.kind === 'load' ? it.ref.loadId : null,
          load: lightLoad(it.load, it.facets),
          stopCount: it.stopCount,
          start: it.startT,
          end: it.endT,
        })),
        deadheadMiles: run.deadheads,
        start: head.startT,
        end: run.items[run.items.length - 1].endT,
        candidates: top,
      });
    }
    return { runs: proposed, unplannable };
  },
});

/**
 * Commit (part of) a proposed plan: assign each pick's driver to every
 * load in that run. Same guards as assignDriverToLoad — status, org-
 * scoped driver — and the same conflict posture: a load someone else
 * just assigned is SKIPPED and reported, never clobbered (§4.6). Not
 * all-or-nothing by design: the dispatcher sees per-load results.
 */
export const applyPlan = mutation({
  args: {
    picks: v.array(
      v.object({
        driverId: v.id('drivers'),
        assignmentIds: v.optional(v.array(v.id('loadCarrierAssignments'))),
        /** Open TMS loads in the same run — committed by creating a leg. */
        loadIds: v.optional(v.array(v.id('loadInformation'))),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const identity = await ctx.auth.getUserIdentity();
    const results: {
      assignmentId?: Id<'loadCarrierAssignments'>;
      loadId?: Id<'loadInformation'>;
      success: boolean;
      reason?: string;
    }[] = [];
    for (const pick of args.picks) {
      const driver = await ctx.db.get(pick.driverId);
      if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
        throw new ConvexError('Driver not found in your organization');
      }
      for (const assignmentId of pick.assignmentIds ?? []) {
        const assignment = await ctx.db.get(assignmentId);
        if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
          throw new ConvexError('Assignment not found');
        }
        if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') {
          results.push({
            assignmentId,
            success: false,
            reason: `Load is ${assignment.status.toLowerCase().replace('_', ' ')}`,
          });
          continue;
        }
        if (assignment.assignedDriverId && assignment.assignedDriverId !== pick.driverId) {
          const current = await ctx.db.get(assignment.assignedDriverId);
          results.push({
            assignmentId,
            success: false,
            reason: `Already assigned to ${
              current ? `${current.firstName} ${current.lastName}` : 'another driver'
            }`,
          });
          continue;
        }
        await ctx.db.patch(assignmentId, {
          assignedDriverId: pick.driverId,
          assignedDriverName: `${driver.firstName} ${driver.lastName}`,
          assignedDriverPhone: driver.phone,
        });
        results.push({ assignmentId, success: true });
      }

      // Open TMS loads commit through the leg model, not by patching an
      // assignment that doesn't exist. Same guarded internal the web uses, so
      // conflicts are reported rather than clobbered.
      for (const loadId of pick.loadIds ?? []) {
        const load = await ctx.db.get(loadId);
        const orgScopes = new Set([...resolved.driverOrgIds, resolved.externalId]);
        if (!load || !orgScopes.has(load.workosOrgId)) {
          results.push({ loadId, success: false, reason: 'Load not found' });
          continue;
        }
        const res: { status: 'SUCCESS' | 'ERROR'; message?: string } = await ctx.runMutation(
          internal.dispatchLegs.assignDriverInternal,
          {
            loadId,
            driverId: pick.driverId,
            assignedBy: identity?.subject ?? 'dispatch-app',
            assignedByName: `${driver.firstName} ${driver.lastName}`,
          },
        );
        results.push({
          loadId,
          success: res.status === 'SUCCESS',
          reason: res.status === 'SUCCESS' ? undefined : (res.message ?? 'Could not assign'),
        });
      }
    }
    return { results };
  },
});


/** Upsert this device's Expo push token for high-severity alert fan-out (§5.7). */
/**
 * Capacity-first board data (§5.9, design `lib-dispatch/capacity.jsx`).
 *
 * The design's premise: a phone never shows "all unassigned". It shows work
 * bounded by *fleet size* — the trucks that need loads — plus the bundled
 * runs the backlog chains into.
 *
 * Deliberately cheaper than suggestPlan, which is why it can back the
 * landing screen: suggestPlan ranks every driver once per proposed run
 * (a location and an HOS read apiece, per run). This inverts the direction —
 * each driver is read once, each backlog load once, and the driver→work
 * scoring is pure haversine over what's already in memory. Reads are
 * O(drivers + backlog), not O(runs × drivers).
 */
export const boardCapacity = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const { plannable, unplannable, truncated } = await shapeBacklog(ctx, resolved);
    const chained = chainIntoRuns(plannable);

    // ── Bundled runs ────────────────────────────────────────────────────
    const runs = chained.map((run) => {
      const head = run.items[0];
      const tail = run.items[run.items.length - 1];
      // Full point list, then squash repeats: a drop and the next pickup in
      // the same city should read as one waypoint, not two.
      const points: (string | null)[] = [];
      for (const it of run.items) points.push(it.originCity, it.destCity);
      const named = points.filter((c): c is string => !!c);
      const squashed = named.filter((c, i) => i === 0 || c !== named[i - 1]);
      return {
        key: refKey(head.ref),
        work: run.items.map((it) => it.ref),
        assignmentIds: run.items
          .map((it) => (it.ref.kind === 'assignment' ? it.ref.assignmentId : null))
          .filter((x): x is Id<'loadCarrierAssignments'> => x !== null),
        loadIds: run.items
          .map((it) => (it.ref.kind === 'load' ? it.ref.loadId : null))
          .filter((x): x is Id<'loadInformation'> => x !== null),
        loadCount: run.items.length,
        from: squashed[0] ?? null,
        to: squashed.length > 1 ? squashed[squashed.length - 1] : null,
        via: squashed.slice(1, -1),
        startT: head.startT,
        endT: tail.endT,
        loadedMiles: run.items.reduce((n, it) => n + (it.load?.effectiveMiles ?? 0), 0),
        deadheadMiles: Math.round(run.deadheads.reduce((n, d) => n + d, 0)),
        stopCount: run.items.reduce((n, it) => n + it.stopCount, 0),
        origin: head.origin,
        customerName: head.load?.customerName ?? null,
        loads: run.items.map((it) => lightLoad(it.load, it.facets)),
      };
    });

    // ── Open trucks ─────────────────────────────────────────────────────
    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');

    const orgScopes = [...new Set([...resolved.driverOrgIds, resolved.externalId])];
    const openLegs: Doc<'dispatchLegs'>[] = [];
    for (const orgId of orgScopes) {
      for (const status of ['PENDING', 'ACTIVE'] as const) {
        openLegs.push(
          ...(await ctx.db
            .query('dispatchLegs')
            .withIndex('by_org_status', (q) => q.eq('workosOrgId', orgId).eq('status', status))
            .collect()),
        );
      }
    }
    const busyDrivers = new Set<string>();
    for (const leg of openLegs) if (leg.driverId) busyDrivers.add(leg.driverId as string);
    for (const a of inProgress) if (a.assignedDriverId) busyDrivers.add(a.assignedDriverId as string);

    // Bounded by fleet size, not backlog size — and it empties out as work
    // is assigned, which is the whole point of the section.
    const open = drivers.filter((d) => !busyDrivers.has(d._id as string));

    const openTrucks = await Promise.all(
      open.map(async (driver) => {
        const location = await latestLocation(ctx, driver._id);
        const hos = await hosForDriver(ctx, driver._id);
        const truck = driver.currentTruckId ? await ctx.db.get(driver.currentTruckId) : null;

        const warns: string[] = [];
        if (hos.onShift && hos.windowRemainingHours != null && hos.windowRemainingHours < 3) {
          warns.push(`~${hos.windowRemainingHours}h left in 14h window (est)`);
        }
        if (hos.cycleRemainingHours < 5) {
          warns.push(`~${hos.cycleRemainingHours}h left in 70h cycle (est)`);
        }

        // Nearest work first. Without a fix we cannot rank by distance, so
        // fall back to soonest-starting rather than inventing a position.
        const scored = runs
          .map((run) => ({
            run,
            deadheadMi:
              location && run.origin
                ? Math.round(
                    milesBetween(location.latitude, location.longitude, run.origin.lat, run.origin.lng),
                  )
                : null,
          }))
          .sort((a, b) => {
            if (a.deadheadMi != null && b.deadheadMi != null) return a.deadheadMi - b.deadheadMi;
            return a.run.startT - b.run.startT;
          })
          .slice(0, 3);

        return {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          truckUnitId: truck?.unitId ?? null,
          hos,
          hosLabel: hosChipLabel(hos),
          warns,
          lastFixAt: location?.recordedAt ?? null,
          suggestions: scored.map((sc) => ({
            key: sc.run.key,
            assignmentIds: sc.run.assignmentIds,
            loadIds: sc.run.loadIds,
            loadCount: sc.run.loadCount,
            from: sc.run.from,
            to: sc.run.to,
            via: sc.run.via,
            startT: sc.run.startT,
            loadedMiles: sc.run.loadedMiles,
            customerName: sc.run.customerName,
            deadheadMi: sc.deadheadMi,
          })),
        };
      }),
    );

    return {
      runs,
      openTrucks,
      /**
       * Everything waiting on a driver: both backlogs, chainable or not.
       * shapeBacklog already spans them and drops past-due, so this agrees
       * with what the board shows rather than being a second opinion.
       */
      unassignedCount: plannable.length + unplannable.length,
      /** True when the open backlog hit its cap — the count is a floor. */
      unassignedTruncated: truncated,
    };
  },
});

export const registerPushToken = mutation({
  args: { token: v.string(), platform: v.union(v.literal('ios'), v.literal('android')) },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const identity = await ctx.auth.getUserIdentity();
    const now = Date.now();
    const existing = await ctx.db
      .query('dispatchPushTokens')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        orgExternalId: resolved.externalId,
        userKey: identity!.subject,
        platform: args.platform,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.insert('dispatchPushTokens', {
        orgExternalId: resolved.externalId,
        userKey: identity!.subject,
        token: args.token,
        platform: args.platform,
        registeredAt: now,
        lastSeenAt: now,
      });
    }
    return { success: true };
  },
});

/**
 * Re-time a stop's appointment window (split-plan §5.4). Capability-gated
 * (canDispatch), org-scoped through the stop's assignment, audit-logged,
 * and returns knock-on warnings (later stops whose windows now collide).
 * Immediately resolves an open MISSED_APPOINTMENT alert when the new
 * window is back in the future (the sweep would catch it within a minute;
 * this keeps the feed honest in real time).
 */
export const adjustStopWindow = mutation({
  args: {
    stopId: v.id('loadStops'),
    windowBeginTime: v.optional(v.string()), // ISO 8601
    windowEndTime: v.string(), // ISO 8601
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const identity = await ctx.auth.getUserIdentity();

    const stop = await ctx.db.get(args.stopId);
    if (!stop) throw new ConvexError('Stop not found');
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();
    const assignment = assignments.find(
      (a) =>
        a.carrierOrgId === resolved.externalId &&
        (a.status === 'AWARDED' || a.status === 'IN_PROGRESS'),
    );
    if (!assignment) throw new ConvexError('Stop not found');

    const end = Date.parse(args.windowEndTime);
    if (!Number.isFinite(end)) throw new ConvexError('Invalid window end time');
    const begin = args.windowBeginTime ? Date.parse(args.windowBeginTime) : null;
    if (args.windowBeginTime && !Number.isFinite(begin!)) throw new ConvexError('Invalid window begin time');
    if (begin != null && begin >= end) throw new ConvexError('Window must end after it begins');

    await ctx.db.patch(args.stopId, {
      windowEndTime: args.windowEndTime,
      windowEndDate: args.windowEndTime.slice(0, 10),
      ...(args.windowBeginTime
        ? { windowBeginTime: args.windowBeginTime, windowBeginDate: args.windowBeginTime.slice(0, 10) }
        : {}),
      updatedAt: Date.now(),
    });

    // Knock-on check: later stops whose window now starts before this one ends.
    const siblings = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();
    const warnings = siblings
      .filter((s) => s.sequenceNumber > stop.sequenceNumber && s.windowBeginTime)
      .filter((s) => Date.parse(s.windowBeginTime!) < end)
      .map((s) => `Stop ${s.sequenceNumber} (${s.address}) now opens before this window ends.`);

    // Window moved into the future → the missed-appointment condition cleared.
    if (end > Date.now()) {
      const open = await ctx.db
        .query('dispatchAlerts')
        .withIndex('by_dedupe', (q) =>
          q.eq('assignmentId', assignment._id).eq('kind', 'MISSED_APPOINTMENT').eq('status', 'open'),
        )
        .first();
      if (open) await ctx.db.patch(open._id, { status: 'resolved', resolvedAt: Date.now() });
    }

    const load = await ctx.db.get(stop.loadId);
    await logAudit(ctx, {
      organizationId: assignment.brokerOrgId,
      entityType: 'loadStop',
      entityId: args.stopId,
      entityName: `Load ${load?.internalId ?? ''} stop ${stop.sequenceNumber}`,
      action: 'window_adjusted',
      performedBy: identity!.subject,
      performedByName: identity!.name ?? undefined,
      performedByEmail: identity!.email ?? undefined,
      description: `Appointment window moved to ${args.windowBeginTime ?? stop.windowBeginTime ?? '—'} → ${args.windowEndTime} by carrier dispatch.`,
    });

    return { success: true, warnings };
  },
});

/** Customers picker for load creation (§5.6). */
export const listCustomers = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    if (!resolved.org.workosOrgId) return [];
    const rows = await ctx.db
      .query('customers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', resolved.org.workosOrgId!))
      .collect();
    return rows
      .filter((c) => c.status === 'Active' && !c.isDeleted)
      .map((c) => ({ _id: c._id, name: c.name, city: c.city, state: c.state }));
  },
});

/**
 * Create a load from the Dispatch app (split-plan §5.6) — the web's
 * createLoadForOrg model function does ALL validation and creation (one
 * path, zero drift), then the load is self-assigned to the caller's org
 * (AWARDED) so it lands on the Board ready for a driver.
 */
export const createLoad = mutation({
  args: dispatchCreateLoadArgs,
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const workosOrgId = resolved.org.workosOrgId;
    if (!workosOrgId) {
      throw new ConvexError('Your organization is not provisioned for load creation yet');
    }
    const identity = await ctx.auth.getUserIdentity();
    const performer = {
      userId: identity!.subject,
      userName: (identity!.name ?? undefined) as string | undefined,
      userEmail: (identity!.email ?? undefined) as string | undefined,
    };
    const loadId = await createLoadForOrg(
      ctx,
      { ...args, workosOrgId, createdBy: performer.userId, createdByName: performer.userName },
      performer,
    );
    const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: workosOrgId,
      carrierOrgId: resolved.externalId,
      status: 'AWARDED',
      offeredAt: Date.now(),
      createdBy: performer.userId,
    });
    return { loadId, assignmentId };
  },
});

// ─────────────────────────────────────────────────────────────────────
// Voice facet assignment — "trip 5 HCR 96036 to Jorge tomorrow".
// Recurring routes produce one load per service day sharing the same
// (HCR, TRIP) tags; the resolver picks the day's load(s), the mutation
// assigns via the web-TMS leg model (dispatchLegs), matching how these
// orgs dispatch everywhere else.
// ─────────────────────────────────────────────────────────────────────

/** Loads matching (hcr, trip[s]) whose service date is one of `dates`. */
export const findLoadsByFacetDates = query({
  args: {
    hcr: v.optional(v.string()),
    trip: v.optional(v.string()),
    trips: v.optional(v.array(v.string())),
    dates: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const webOrgId = resolved.org.workosOrgId;
    if (!webOrgId) return [];
    const dates = new Set(args.dates);
    // Union across every named trip ("trip 5 and 6 contract 96036"); a
    // bare-HCR command resolves once with no trip filter.
    const tripValues = [
      ...new Set([...(args.trips ?? []), ...(args.trip ? [args.trip] : [])]),
    ].slice(0, 10);
    const idSets = await Promise.all(
      tripValues.length === 0
        ? [findLoadIdsByFacets(ctx, { workosOrgId: webOrgId, hcr: args.hcr })]
        : tripValues.map((trip) =>
            findLoadIdsByFacets(ctx, { workosOrgId: webOrgId, hcr: args.hcr, trip }),
          ),
    );
    const loadIds = [...new Set(idSets.flat())];
    const out: {
      loadId: Id<'loadInformation'>;
      internalId: string;
      firstStopDate: string;
      customerName: string | null;
      currentDriverName: string | null;
      tripNumber: string | null;
      hcr: string | null;
    }[] = [];
    for (const loadId of loadIds) {
      const load = await ctx.db.get(loadId);
      if (!load || load.status === 'Canceled') continue;
      if (!load.firstStopDate || !dates.has(load.firstStopDate)) continue;
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      const liveLeg = legs.find((l) => l.status === 'PENDING' || l.status === 'ACTIVE');
      const currentDriver = liveLeg?.driverId ? await ctx.db.get(liveLeg.driverId) : null;
      const facets = await getLoadFacets(ctx, loadId);
      out.push({
        loadId,
        internalId: load.internalId,
        firstStopDate: load.firstStopDate,
        customerName: load.customerName ?? null,
        currentDriverName: currentDriver
          ? `${currentDriver.firstName} ${currentDriver.lastName}`
          : null,
        tripNumber: facets.trip ?? null,
        hcr: facets.hcr ?? null,
      });
    }
    out.sort((a, b) => a.firstStopDate.localeCompare(b.firstStopDate));
    return out;
  },
});

/**
 * Read-only load view (Phase-1 "load detail", built 2026-07-31): doc +
 * facet tags + stop timeline + the live driver from either assignment
 * model. Reachable when the load belongs to the caller's web-TMS org OR
 * is offered/awarded to their carrier org. Returns null (never throws)
 * so the screen can render a clean not-found state.
 */
export const getLoadDetail = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const load = await ctx.db.get(args.loadId);
    if (!load) return null;
    let assignment: Doc<'loadCarrierAssignments'> | null = null;
    let allowed = load.workosOrgId === resolved.org.workosOrgId;
    if (!allowed) {
      const assignments = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();
      assignment = assignments.find((a) => a.carrierOrgId === resolved.externalId) ?? null;
      allowed = assignment !== null;
    }
    if (!allowed) return null;

    const stops = (
      await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect()
    ).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const facets = await getLoadFacets(ctx, load._id);
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();
    const liveLeg = legs.find((l) => l.status === 'PENDING' || l.status === 'ACTIVE');
    const driverId = liveLeg?.driverId ?? assignment?.assignedDriverId ?? null;
    const driver = driverId ? await ctx.db.get(driverId) : null;

    return {
      _id: load._id,
      internalId: load.internalId,
      status: load.status,
      trackingStatus: load.trackingStatus ?? null,
      customerName: load.customerName ?? null,
      commodityDescription: load.commodityDescription ?? null,
      weight: load.weight ?? null,
      effectiveMiles: load.effectiveMiles ?? null,
      equipmentType: load.equipmentType ?? null,
      externalSource: load.externalSource ?? null,
      tripNumber: facets.trip ?? null,
      hcr: facets.hcr ?? null,
      legStatus: liveLeg?.status ?? null,
      driver: driver
        ? { _id: driver._id, firstName: driver.firstName, lastName: driver.lastName, phone: driver.phone }
        : null,
      stops: stops.map((s) => ({
        _id: s._id,
        sequenceNumber: s.sequenceNumber,
        stopType: s.stopType,
        address: s.address,
        city: s.city ?? null,
        state: s.state ?? null,
        windowBeginDate: s.windowBeginDate ?? null,
        windowBeginTime: s.windowBeginTime ?? null,
        windowEndTime: s.windowEndTime ?? null,
        checkedInAt: s.checkedInAt ?? null,
        checkedOutAt: s.checkedOutAt ?? null,
      })),
    };
  },
});

/**
 * Driver profile (Phase-1 "driver detail"): identity + credentials with
 * expirations, current/next load via the leg model, and last-known GPS
 * fix age. History rides the existing listDriverHistory query client-side.
 */
export const getDriverDetail = query({
  args: { driverId: v.id('drivers') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
      return null;
    }
    const location = await latestLocation(ctx, driver._id);
    const lightLoadOf = async (loadId: Id<'loadInformation'>) => {
      const load = await ctx.db.get(loadId);
      if (!load) return null;
      const facets = await getLoadFacets(ctx, load._id);
      return {
        _id: load._id,
        internalId: load.internalId,
        customerName: load.customerName ?? null,
        tripNumber: facets.trip ?? null,
        hcr: facets.hcr ?? null,
      };
    };
    const activeLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', driver._id).eq('status', 'ACTIVE'))
      .collect();
    const pendingLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', driver._id).eq('status', 'PENDING'))
      .collect();
    const nextPending =
      pendingLegs.sort(
        (a, b) => (a.scheduledStartMs ?? Infinity) - (b.scheduledStartMs ?? Infinity),
      )[0] ?? null;
    const hos = await hosForDriver(ctx, driver._id);

    return {
      _id: driver._id,
      firstName: driver.firstName,
      lastName: driver.lastName,
      phone: driver.phone,
      email: driver.email,
      employmentStatus: driver.employmentStatus,
      employmentType: driver.employmentType,
      hireDate: driver.hireDate,
      licenseClass: driver.licenseClass,
      licenseState: driver.licenseState,
      licenseExpiration: driver.licenseExpiration,
      medicalExpiration: driver.medicalExpiration ?? null,
      twicExpiration: driver.twicExpiration ?? null,
      lastFixAt: location?.recordedAt ?? null,
      currentLoad: activeLegs[0] ? await lightLoadOf(activeLegs[0].loadId) : null,
      nextLoad: nextPending ? await lightLoadOf(nextPending.loadId) : null,
      hos,
      hosLabel: hosChipLabel(hos),
    };
  },
});

/** Assign one driver to several loads via the web-TMS leg model. */
export const assignDriverToLoadsWeb = mutation({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const identity = await ctx.auth.getUserIdentity();
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
      throw new ConvexError('Driver not found in your organization');
    }
    const results: { internalId: string | null; success: boolean; reason?: string }[] = [];
    for (const loadId of args.loadIds.slice(0, 20)) {
      const load = await ctx.db.get(loadId);
      if (!load || load.workosOrgId !== resolved.org.workosOrgId) {
        results.push({ internalId: null, success: false, reason: 'Load not found' });
        continue;
      }
      const res: { status: 'SUCCESS' | 'ERROR'; message?: string } = await ctx.runMutation(
        internal.dispatchLegs.assignDriverInternal,
        {
          loadId,
          driverId: args.driverId,
          assignedBy: identity?.subject ?? 'dispatch-app',
          assignedByName: 'Dispatch voice',
        },
      );
      results.push({
        internalId: load.internalId,
        success: res.status === 'SUCCESS',
        reason: res.message,
      });
    }
    return { results };
  },
});
