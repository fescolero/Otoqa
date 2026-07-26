import { mutation, query, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import {
  CAPABILITY_SLUGS,
  getCallerPermissionClaims,
  resolveClerkCarrierMembership,
  type DispatchCapability,
} from './lib/auth';
import { isPermitted } from './lib/permissions';
import { getLoadFacets } from './lib/loadFacets';
import { carrierStatementsForOrg, carrierStatementDetailsForOrg } from './mobileSettlements';
import { logAudit } from './lib/audit';
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
  if (!identity) throw new Error('Unauthenticated');

  const claims = identity as unknown as { org_id?: string; organizationId?: string };
  const claimOrg = claims.org_id ?? claims.organizationId;

  if (claimOrg) {
    const permissionClaims = await getCallerPermissionClaims(ctx);
    if (!isPermitted(permissionClaims, CAPABILITY_SLUGS[capability])) {
      throw new Error(`Not authorized: missing ${capability}`);
    }
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', claimOrg))
      .first();
    if (!org || org.isDeleted) throw new Error('Organization not provisioned for dispatch');
    return {
      org,
      externalId: org.clerkOrgId ?? claimOrg,
      driverOrgIds: [org._id as string, claimOrg],
    };
  }

  const membership = await resolveClerkCarrierMembership(ctx);
  if (!membership) throw new Error(`Not authorized: missing ${capability}`);
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
async function orgDrivers(ctx: QueryCtx, resolved: ResolvedOrg): Promise<Doc<'drivers'>[]> {
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

async function assignmentsByStatus(
  ctx: QueryCtx,
  externalId: string,
  status: 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED',
) {
  return await ctx.db
    .query('loadCarrierAssignments')
    .withIndex('by_carrier', (q) => q.eq('carrierOrgId', externalId).eq('status', status))
    .collect();
}

/** Board data — AWARDED + IN_PROGRESS assignments, enriched like getActiveLoads. */
export const listActiveAssignments = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const assignments = [
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'AWARDED')),
      ...(await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS')),
    ];

    return Promise.all(
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

/** Fleet list — active drivers + last ping + current load (mirrors getDrivers). */
export const listDrivers = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewFleet');
    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');

    return Promise.all(
      drivers.map(async (driver) => {
        const lastLocation = await latestLocation(ctx, driver._id);
        const currentAssignment = inProgress.find((a) => a.assignedDriverId === driver._id) ?? null;
        const load = currentAssignment ? await ctx.db.get(currentAssignment.loadId) : null;
        return {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          employmentStatus: driver.employmentStatus,
          currentTruckId: driver.currentTruckId,
          lastLocation,
          currentLoad: load ? { _id: load._id, internalId: load.internalId } : null,
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
 * Ranked driver suggestions for one assignment — proximity to the first
 * pickup, current workload, ping freshness. Blocked/warned candidates are
 * RANKED WITH WARNINGS, never hidden (v8 design). No HOS chip yet (D11);
 * equipment scoring arrives with the D12 endorsement fields.
 */
export const suggestDriversForLoad = query({
  args: { assignmentId: v.id('loadCarrierAssignments') },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new Error('Assignment not found');
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

    const drivers = await orgDrivers(ctx, resolved);
    const inProgress = await assignmentsByStatus(ctx, resolved.externalId, 'IN_PROGRESS');
    const staleCutoff = Date.now() - 45 * 60 * 1000;

    const candidates = await Promise.all(
      drivers
        .filter((d) => d._id !== assignment.assignedDriverId)
        .map(async (d) => {
          const loc = await latestLocation(ctx, d._id);
          const activeCount = inProgress.filter((a) => a.assignedDriverId === d._id).length;
          const mi =
            origin && loc ? milesBetween(loc.latitude, loc.longitude, origin.lat, origin.lng) : null;
          const warns: string[] = [];
          if (activeCount > 0) warns.push(`On ${activeCount} active load${activeCount > 1 ? 's' : ''}`);
          if (!loc) warns.push('No GPS data');
          else if (loc.recordedAt < staleCutoff) warns.push('Ping older than 45 min');
          if (mi != null && mi > 60) warns.push(`${mi} mi deadhead`);
          let score = 100 + (activeCount === 0 ? 22 : -7 * activeCount);
          if (mi != null) score -= mi * 0.9;
          if (!loc) score -= 25;
          else if (loc.recordedAt < staleCutoff) score -= 15;
          return {
            _id: d._id,
            firstName: d.firstName,
            lastName: d.lastName,
            phone: d.phone,
            milesFromPickup: mi,
            activeLoads: activeCount,
            lastPingAt: loc?.recordedAt ?? null,
            warns,
            score,
          };
        }),
    );
    return candidates.sort((a, b) => b.score - a.score);
  },
});

/**
 * Dual-path driver assignment for the Dispatch app. The legacy
 * loadCarrierAssignments.assignDriver stays for old builds; its org-claim
 * path can't serve WorkOS staff (assignments key on the CLERK org id).
 * Conflict-aware per §4.6: returns alreadyAssigned instead of clobbering.
 */
export const assignDriverToLoad = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveOrgForRead(ctx, 'canDispatch');
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.carrierOrgId !== resolved.externalId) {
      throw new Error('Assignment not found');
    }
    if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') {
      throw new Error('Can only assign driver to awarded or in-progress loads');
    }
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !resolved.driverOrgIds.includes(driver.organizationId)) {
      throw new Error('Driver not found in your organization');
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


/** Upsert this device's Expo push token for high-severity alert fan-out (§5.7). */
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
    if (!stop) throw new Error('Stop not found');
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();
    const assignment = assignments.find(
      (a) =>
        a.carrierOrgId === resolved.externalId &&
        (a.status === 'AWARDED' || a.status === 'IN_PROGRESS'),
    );
    if (!assignment) throw new Error('Stop not found');

    const end = Date.parse(args.windowEndTime);
    if (!Number.isFinite(end)) throw new Error('Invalid window end time');
    const begin = args.windowBeginTime ? Date.parse(args.windowBeginTime) : null;
    if (args.windowBeginTime && !Number.isFinite(begin!)) throw new Error('Invalid window begin time');
    if (begin != null && begin >= end) throw new Error('Window must end after it begins');

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
      throw new Error('Your organization is not provisioned for load creation yet');
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
