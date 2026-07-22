// Idempotent seeder for the chargeComponents catalog.
//
// Inserts the standard library of pay/bill components for an org. Existing
// rows (matched by templateId within the same org) are left untouched — so
// re-running is safe and orgs that have customized seeded rows don't lose
// their edits.
//
// Two passes: pass 1 inserts all rows without pair references; pass 2 walks
// templates with pairCode and patches pairedComponentId on both sides once
// the IDs are known. This avoids cyclic-creation ordering problems.
//
// Invoke from:
//   - Org bootstrap flow (new BROKER org → seed once)
//   - Migration script (one-shot for existing orgs)
//   - Admin UI (optional "refresh seed catalog" action)

import { internalMutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import { CHARGE_COMPONENT_TEMPLATES, validateCatalog } from './chargeComponentsCatalog';
import type { Doc, Id } from '../_generated/dataModel';

export type SeedChargeComponentsResult = {
  workosOrgId: string;
  inserted: number;
  skipped: number;
  pairsLinked: number;
  catalogSize: number;
};

// Idempotent seeder that can be called from any mutation context. Org
// bootstrap (settings.upsertOrgSettings) invokes this on first BROKER org
// creation; the internalMutation below is the same logic exposed for
// manual/admin invocation against existing orgs.
export async function seedChargeComponentsLogic(
  ctx: MutationCtx,
  args: { workosOrgId: string; createdBy: string },
): Promise<SeedChargeComponentsResult> {
  const { workosOrgId, createdBy } = args;

  const validation = validateCatalog(CHARGE_COMPONENT_TEMPLATES);
  if (!validation.ok) {
    throw new Error(
      `chargeComponents catalog invalid:\n  - ${validation.errors.join('\n  - ')}`,
    );
  }

  // Load existing rows for this org keyed by templateId so re-runs skip them.
  const existing = await ctx.db
    .query('chargeComponents')
    .withIndex('by_org_active', q => q.eq('workosOrgId', workosOrgId))
    .collect();
  const existingByTemplateId = new Map<string, Doc<'chargeComponents'>>();
  for (const row of existing) {
    if (row.templateId) existingByTemplateId.set(row.templateId, row);
  }

  const now = Date.now();
  let inserted = 0;
  let skipped = 0;
  const idByCode = new Map<string, Id<'chargeComponents'>>();

  // Pass 1 — insert any templates not yet present
  for (const template of CHARGE_COMPONENT_TEMPLATES) {
    const tid = template.templateId;
    if (!tid) continue; // catalog validator already guarded this

    const existingRow = existingByTemplateId.get(tid);
    if (existingRow) {
      idByCode.set(template.code, existingRow._id);
      skipped++;
      continue;
    }

    const { pairCode: _pairCode, ...rest } = template;
    const id = await ctx.db.insert('chargeComponents', {
      ...rest,
      workosOrgId,
      createdAt: now,
      updatedAt: now,
      createdBy,
    });
    idByCode.set(template.code, id);
    inserted++;
  }

  // Pass 2 — wire up pairedComponentId for both sides of any pair
  let pairsLinked = 0;
  for (const template of CHARGE_COMPONENT_TEMPLATES) {
    if (!template.pairCode) continue;

    const selfId = idByCode.get(template.code);
    const partnerId = idByCode.get(template.pairCode);
    if (!selfId || !partnerId) continue;

    const selfDoc = await ctx.db.get(selfId);
    if (!selfDoc) continue;

    if (selfDoc.pairedComponentId !== partnerId) {
      await ctx.db.patch(selfId, {
        pairedComponentId: partnerId,
        updatedAt: now,
      });
      pairsLinked++;
    }
  }

  return {
    workosOrgId,
    inserted,
    skipped,
    pairsLinked,
    catalogSize: CHARGE_COMPONENT_TEMPLATES.length,
  };
}

// Admin/manual entry point — refresh catalog for an existing org.
export const seedChargeComponentsForOrg = internalMutation({
  args: {
    workosOrgId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => seedChargeComponentsLogic(ctx, args),
});
