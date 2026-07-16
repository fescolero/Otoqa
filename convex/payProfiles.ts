// Pay Profiles — public-facing CRUD for the new pay engine UI.
//
// All operations are org-scoped via assertCallerOwnsOrg. List/get return
// profiles with enriched counts (drivers + carriers using the profile)
// computed at query time from payeeProfileAssignments.
//
// Naming: this file mirrors the design's "Pay profile" concept and replaces
// the legacy rateProfiles.ts surface for new-engine orgs.

import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { currencyValidator } from './payEngine/schema';
import type { Id } from './_generated/dataModel';

// ============================================================================
// QUERIES
// ============================================================================

/** List pay profiles for an org. Each profile is enriched with rules + counts. */
export const listForOrg = query({
  args: {
    workosOrgId: v.string(),
    includeInactive: v.optional(v.boolean()),
    payeeType: v.optional(v.union(v.literal('DRIVER'), v.literal('CARRIER'))),
  },
  handler: async (ctx, { workosOrgId, includeInactive, payeeType }) => {
    await assertCallerOwnsOrg(ctx, workosOrgId);

    const profilesQuery = payeeType
      ? ctx.db
          .query('payProfiles')
          .withIndex('by_org_payeeType', q =>
            q.eq('workosOrgId', workosOrgId).eq('payeeType', payeeType))
      : ctx.db
          .query('payProfiles')
          .withIndex('by_org_active', q => q.eq('workosOrgId', workosOrgId));

    const profiles = await profilesQuery.collect();
    const filtered = includeInactive ? profiles : profiles.filter(p => p.isActive);

    const enriched = await Promise.all(
      filtered.map(async (p) => {
        const rules = await ctx.db
          .query('payRules')
          .withIndex('by_profile_active', q =>
            q.eq('profileId', p._id).eq('isActive', true))
          .collect();
        const assignments = await ctx.db
          .query('payeeProfileAssignments')
          .withIndex('by_profile', q => q.eq('profileId', p._id))
          .collect();
        const activeAssignments = assignments.filter(a => a.isActive);
        return {
          ...p,
          rules: rules.sort((a, b) => a.sortOrder - b.sortOrder),
          inUseDrivers: activeAssignments.filter(a => a.payeeType === 'DRIVER').length,
          inUseCarriers: activeAssignments.filter(a => a.payeeType === 'CARRIER').length,
          updatedByName: await resolveActorName(ctx, workosOrgId, p._id, p.updatedBy ?? p.createdBy),
        };
      }),
    );
    return enriched;
  },
});

/** Single profile with full rule list (sorted) and counts. */
export const get = query({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile) return null;
    if (profile.workosOrgId !== callerOrgId) return null;

    // Active rules only — removeRule soft-deactivates (audit trail), and a
    // removed line must actually leave the editor's rates table.
    const rules = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q => q.eq('profileId', profileId).eq('isActive', true))
      .collect();
    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_profile', q => q.eq('profileId', profileId))
      .collect();
    const activeAssignments = assignments.filter(a => a.isActive);

    return {
      ...profile,
      rules: rules.sort((a, b) => a.sortOrder - b.sortOrder),
      inUseDrivers: activeAssignments.filter(a => a.payeeType === 'DRIVER').length,
      inUseCarriers: activeAssignments.filter(a => a.payeeType === 'CARRIER').length,
    };
  },
});

/** Merged audit history for a profile + all of its rules. Sorted newest
 *  first. Used by the History tab on the editor page. */
export const getProfileHistory = query({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile || profile.workosOrgId !== callerOrgId) return [];

    // 1. Profile-level entries
    const profileEntries = await ctx.db
      .query('auditLog')
      .withIndex('by_org_entity', q =>
        q.eq('organizationId', callerOrgId).eq('entityType', 'payProfile').eq('entityId', profileId))
      .collect();

    // 2. Rule-level entries — every rule that belongs to this profile,
    //    including soft-archived rules (so removals stay visible in history).
    const rules = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q => q.eq('profileId', profileId))
      .collect();
    const ruleEntries: typeof profileEntries = [];
    for (const r of rules) {
      const entries = await ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', q =>
          q.eq('organizationId', callerOrgId).eq('entityType', 'payRule').eq('entityId', r._id))
        .collect();
      ruleEntries.push(...entries);
    }

    const merged = [...profileEntries, ...ruleEntries]
      // Sort newest first
      .sort((a, b) => b.timestamp - a.timestamp);

    return merged.map(e => ({
      _id: e._id,
      entityType: e.entityType as 'payProfile' | 'payRule',
      entityId: e.entityId,
      action: e.action,
      description: e.description,
      performedBy: e.performedBy,
      performedByName: e.performedByName,
      performedByEmail: e.performedByEmail,
      timestamp: e.timestamp,
    }));
  },
});

/** Drivers + carriers assigned to a profile. For the "Using this profile" modal. */
export const listAssignedPayees = query({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile || profile.workosOrgId !== callerOrgId) {
      return { drivers: [], carriers: [] };
    }

    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_profile', q => q.eq('profileId', profileId))
      .collect();
    const active = assignments.filter(a => a.isActive);

    const drivers = [];
    const carriers = [];
    for (const a of active) {
      if (a.payeeType === 'DRIVER') {
        const driver = await ctx.db.get(a.payeeId as Id<'drivers'>);
        if (driver) {
          drivers.push({
            assignmentId: a._id,
            driverId: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            phone: driver.phone,
            email: driver.email,
            isDefault: a.isDefault ?? false,
            assignedAt: a.createdAt,
            effectiveStart: a.effectiveStart,
            selectionStrategy: a.selectionStrategy,
          });
        }
      } else if (a.payeeType === 'CARRIER') {
        const partnership = await ctx.db.get(a.payeeId as Id<'carrierPartnerships'>);
        if (partnership) {
          carriers.push({
            assignmentId: a._id,
            carrierPartnershipId: partnership._id,
            carrierName: partnership.carrierName,
            mcNumber: partnership.mcNumber,
            usDotNumber: partnership.usdotNumber,
            isDefault: a.isDefault ?? false,
            assignedAt: a.createdAt,
            effectiveStart: a.effectiveStart,
            selectionStrategy: a.selectionStrategy,
          });
        }
      }
    }
    return { drivers, carriers };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

const payBasisValidator = v.union(
  v.literal('MILEAGE'),
  v.literal('HOURLY'),
  v.literal('PERCENTAGE'),
  v.literal('FLAT'),
  v.literal('HYBRID'),
);

// Starter rate lines seeded atomically with the profile (create page).
// Components are referenced by catalog code and resolved server-side so the
// client never has to pre-fetch componentIds; an unknown code aborts the
// whole mutation, leaving no half-created profile behind.
const initialRuleValidator = v.object({
  name: v.string(),
  componentCode: v.string(),
  trigger: v.object({
    source: v.string(),
    transform: v.optional(v.union(
      v.literal('IDENTITY'),
      v.literal('HOURS_FROM_MINUTES'),
      v.literal('COUNT'),
      v.literal('SUM'),
      v.literal('PERCENT'),
    )),
    filter: v.optional(v.string()),
  }),
  rateAmountMicroCents: v.int64(),
  minThreshold: v.optional(v.number()),
});

export const create = mutation({
  args: {
    workosOrgId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    payeeType: v.string(),
    payBasis: payBasisValidator,
    currency: currencyValidator,
    country: v.optional(v.string()),
    state: v.optional(v.string()),
    contractTag: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    initialRules: v.optional(v.array(initialRuleValidator)),
  },
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();

    // Only one profile can be the default per payee type — setting the flag
    // here clears it everywhere else so the invariant holds.
    if (args.isDefault) {
      const siblings = await ctx.db
        .query('payProfiles')
        .withIndex('by_org_payeeType', q =>
          q.eq('workosOrgId', args.workosOrgId).eq('payeeType', args.payeeType))
        .collect();
      for (const s of siblings) {
        if (s.isDefault) await ctx.db.patch(s._id, { isDefault: false, updatedAt: now, updatedBy: userId });
      }
    }

    const profileId = await ctx.db.insert('payProfiles', {
      workosOrgId: args.workosOrgId,
      name: args.name,
      description: args.description,
      payeeType: args.payeeType,
      payBasis: args.payBasis,
      currency: args.currency,
      country: args.country,
      state: args.state,
      contractTag: args.contractTag,
      isDefault: args.isDefault,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      updatedBy: userId,
    });

    for (const [i, rule] of (args.initialRules ?? []).entries()) {
      const component = await ctx.db
        .query('chargeComponents')
        .withIndex('by_org_code', q =>
          q.eq('workosOrgId', args.workosOrgId).eq('code', rule.componentCode))
        .first();
      if (!component) {
        throw new Error(`Charge component "${rule.componentCode}" not found for this organization`);
      }
      const ruleId = await ctx.db.insert('payRules', {
        profileId,
        name: rule.name,
        componentId: component._id,
        trigger: rule.trigger,
        rateAmountMicroCents: rule.rateAmountMicroCents,
        minThreshold: rule.minThreshold,
        isActive: true,
        sortOrder: i + 1,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      });
      await ctx.db.insert('auditLog', {
        organizationId: args.workosOrgId,
        entityType: 'payRule',
        entityId: ruleId,
        entityName: rule.name,
        action: 'created',
        description: `Added rule "${rule.name}" to profile "${args.name}"`,
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        timestamp: now,
      });
    }

    await ctx.db.insert('auditLog', {
      organizationId: args.workosOrgId,
      entityType: 'payProfile',
      entityId: profileId,
      entityName: args.name,
      action: 'created',
      description: `Created pay profile: ${args.name}`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return profileId;
  },
});

export const update = mutation({
  args: {
    profileId: v.id('payProfiles'),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.string()),
      payBasis: v.optional(payBasisValidator),
      currency: v.optional(currencyValidator),
      country: v.optional(v.string()),
      state: v.optional(v.string()),
      contractTag: v.optional(v.string()),
      isDefault: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { profileId, patch }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    const cleaned = stripUndefined(patch);

    // Keep the single-default invariant: promoting this profile demotes any
    // other default of the same payee type.
    if (cleaned.isDefault === true) {
      const siblings = await ctx.db
        .query('payProfiles')
        .withIndex('by_org_payeeType', q =>
          q.eq('workosOrgId', profile.workosOrgId).eq('payeeType', profile.payeeType))
        .collect();
      for (const s of siblings) {
        if (s._id !== profileId && s.isDefault) {
          await ctx.db.patch(s._id, { isDefault: false, updatedAt: now, updatedBy: userId });
        }
      }
    }

    await ctx.db.patch(profileId, { ...cleaned, updatedAt: now, updatedBy: userId });

    const changedKeys = Object.keys(cleaned);
    if (changedKeys.length > 0) {
      await ctx.db.insert('auditLog', {
        organizationId: orgId,
        entityType: 'payProfile',
        entityId: profileId,
        entityName: profile.name,
        action: 'updated',
        description: describeProfileUpdate(profile, cleaned),
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        changedFields: changedKeys,
        timestamp: now,
      });
    }
  },
});

export const archive = mutation({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');
    const now = Date.now();
    await ctx.db.patch(profileId, { isActive: false, updatedAt: now, updatedBy: userId });
    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payProfile',
      entityId: profileId,
      entityName: profile.name,
      action: 'archived',
      description: `Archived pay profile: ${profile.name}`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

export const restore = mutation({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');
    const now = Date.now();
    await ctx.db.patch(profileId, { isActive: true, updatedAt: now, updatedBy: userId });
    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payProfile',
      entityId: profileId,
      entityName: profile.name,
      action: 'restored',
      description: `Restored pay profile: ${profile.name}`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

/** Duplicate a profile + all its rules. New profile starts as active, not default,
 *  with name suffixed " (copy)". Useful when an admin wants a one-off variant. */
export const duplicate = mutation({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const original = await ctx.db.get(profileId);
    if (!original) throw new Error('Pay profile not found');
    if (original.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    const newId = await ctx.db.insert('payProfiles', {
      workosOrgId: original.workosOrgId,
      name: `${original.name} (copy)`,
      description: original.description,
      payeeType: original.payeeType,
      payBasis: original.payBasis,
      currency: original.currency,
      country: original.country,
      state: original.state,
      contractTag: original.contractTag,
      // New copies are never the default — admin opts in deliberately.
      isDefault: false,
      isActive: true,
      // Link back to the template so we can show "duplicated from" if needed
      templateId: original.templateId ?? `duplicated-from:${profileId}`,
      postCalcRules: original.postCalcRules,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      updatedBy: userId,
    });

    // Copy active rules only — soft-removed lines shouldn't resurrect in copies.
    const rules = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q => q.eq('profileId', profileId).eq('isActive', true))
      .collect();
    for (const r of rules) {
      await ctx.db.insert('payRules', {
        profileId: newId,
        name: r.name,
        componentId: r.componentId,
        trigger: r.trigger,
        rateAmountMicroCents: r.rateAmountMicroCents,
        tieredRate: r.tieredRate,
        minThreshold: r.minThreshold,
        maxCap: r.maxCap,
        minAmountCents: r.minAmountCents,
        maxAmountCents: r.maxAmountCents,
        equipmentTypeCondition: r.equipmentTypeCondition,
        customerCondition: r.customerCondition,
        isActive: r.isActive,
        sortOrder: r.sortOrder,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      });
    }

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payProfile',
      entityId: newId,
      entityName: `${original.name} (copy)`,
      action: 'duplicated',
      description: `Duplicated pay profile "${original.name}" → "${original.name} (copy)"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return newId;
  },
});

/** Set (or clear) a load-level pay profile override.
 *
 *  The calc engine's selection precedence is: leg override → LOAD OVERRIDE →
 *  jurisdiction assignment → distance assignment → driver default. Setting
 *  this makes every driver leg on the load pay off the chosen profile
 *  regardless of the driver's assignments.
 *
 *  After patching, pay is recalculated for each non-canceled driver leg —
 *  legacy engine inline (unchanged behavior: it doesn't read overrides) and
 *  the new pay engine via the same latest-wins scheduled cascade that
 *  loadPayables.recalculate uses, so displayed payItems refresh reactively. */
export const setLoadOverride = mutation({
  args: {
    loadId: v.id('loadInformation'),
    // Omit to clear the override (back to automatic selection).
    profileId: v.optional(v.id('payProfiles')),
  },
  handler: async (ctx, { loadId, profileId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    let profileName: string | null = null;
    if (profileId) {
      const profile = await ctx.db.get(profileId);
      if (!profile) throw new Error('Pay profile not found');
      if (profile.workosOrgId !== orgId) throw new Error('Pay profile belongs to a different organization');
      if (!profile.isActive) throw new Error('Cannot use an archived pay profile as an override');
      if (profile.payeeType !== 'DRIVER') throw new Error('Load pay overrides must use a driver profile');
      profileName = profile.name;
    }

    if ((load.payProfileOverrideId ?? null) === (profileId ?? null)) return null;

    const now = Date.now();
    // Patching with an explicit undefined removes the field (clears override).
    await ctx.db.patch(loadId, { payProfileOverrideId: profileId, updatedAt: now });

    // Recalculate every driver leg so pay reflects the new selection.
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', q => q.eq('loadId', loadId))
      .collect();
    for (const leg of legs) {
      if (!leg.driverId || leg.status === 'CANCELED') continue;
      await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
        legId: leg._id,
        userId,
      });
      await ctx.db.patch(leg._id, { latestRecalcRequestedAt: now });
      await ctx.scheduler.runAfter(0, internal.payEngine.calculatePayForLeg.calculatePayForLeg, {
        legId: leg._id,
        userId,
        requestedAt: now,
      });
    }

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'load',
      entityId: loadId,
      entityName: load.orderNumber,
      action: 'updated',
      description: profileName
        ? `Set pay profile override to "${profileName}" for load ${load.orderNumber}`
        : `Cleared pay profile override for load ${load.orderNumber} (back to driver default)`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return null;
  },
});

// ============================================================================
// HELPERS
// ============================================================================

/** Human-readable name for the profile list's "Updated by" cell — the raw
 *  actor id is a WorkOS user id ("user_01KAF…"), useless on screen.
 *  `actorId` is the profile's updatedBy stamp (createdBy for legacy rows).
 *  Resolution order:
 *    1. The actor's orgMembers record (name, then email) — exact person.
 *    2. Latest profile-level audit entry's performedByName/Email — carries
 *       the identity name even when orgMembers hasn't synced the user.
 *    3. "System" for seeded/service ids, "Unknown user" for unresolvable
 *       WorkOS ids — never the raw id. */
async function resolveActorName(
  ctx: QueryCtx,
  workosOrgId: string,
  profileId: Id<'payProfiles'>,
  actorId: string,
): Promise<string> {
  const member = await ctx.db
    .query('orgMembers')
    .withIndex('by_org_user', q =>
      q.eq('organizationId', workosOrgId).eq('workosUserId', actorId))
    .first();
  if (member) {
    const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
    if (name) return name;
    if (member.email) return member.email;
  }

  const lastEntry = await ctx.db
    .query('auditLog')
    .withIndex('by_org_entity', q =>
      q.eq('organizationId', workosOrgId).eq('entityType', 'payProfile').eq('entityId', profileId))
    .order('desc')
    .first();
  if (lastEntry && lastEntry.performedBy === actorId) {
    const fromAudit = lastEntry.performedByName ?? lastEntry.performedByEmail;
    if (fromAudit) return fromAudit;
  }

  return actorId.startsWith('user_') ? 'Unknown user' : 'System';
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Build a human-readable description of what changed on a profile update.
 *  Falls back to a generic "Updated fields: X, Y" when changes are bulky. */
function describeProfileUpdate(
  before: { name: string; description?: string; currency: string; payBasis: string },
  cleaned: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if ('name' in cleaned && cleaned.name !== before.name) {
    parts.push(`Renamed "${before.name}" → "${cleaned.name}"`);
  }
  if ('description' in cleaned && cleaned.description !== before.description) {
    parts.push('Updated description');
  }
  if ('currency' in cleaned && cleaned.currency !== before.currency) {
    parts.push(`Changed currency ${before.currency} → ${cleaned.currency}`);
  }
  if ('payBasis' in cleaned && cleaned.payBasis !== before.payBasis) {
    parts.push(`Changed pay basis ${before.payBasis} → ${cleaned.payBasis}`);
  }
  if ('isDefault' in cleaned) {
    parts.push(cleaned.isDefault ? 'Marked as default' : 'Cleared default');
  }
  if ('country' in cleaned || 'state' in cleaned || 'contractTag' in cleaned) {
    parts.push('Updated jurisdiction');
  }
  if (parts.length === 0) return `Updated ${Object.keys(cleaned).join(', ')}`;
  return parts.join(' · ');
}
