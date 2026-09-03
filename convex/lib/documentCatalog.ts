/**
 * Effective documents catalog = system defaults (code) merged with an
 * org's `documentTypes` rows (overrides + custom types).
 *
 * Lives in lib/ (no Convex function exports) so both documentTypes.ts and
 * entityDocuments.ts can import it without a module cycle.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { EffectiveDocumentType } from '../_helpers/documentStatus';
import { SYSTEM_DOCUMENT_TYPES, type DocumentEntity } from './documentTypeDefaults';

export const documentEntityValidator = v.union(
  v.literal('driver'),
  v.literal('carrier'),
  v.literal('organization'),
);

export const effectiveDocumentTypeValidator = v.object({
  key: v.string(),
  entity: documentEntityValidator,
  name: v.string(),
  expires: v.boolean(),
  issueDateRequired: v.boolean(),
  uploadRequired: v.boolean(),
  singleton: v.boolean(),
  sharedByDefault: v.boolean(),
  mirrorField: v.optional(v.string()),
  partnerTypeKey: v.optional(v.string()),
  isSystem: v.boolean(),
  hidden: v.boolean(),
  sortOrder: v.number(),
});

export function mergeCatalog(
  rows: readonly Doc<'documentTypes'>[],
  entity?: DocumentEntity,
): EffectiveDocumentType[] {
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  const result: EffectiveDocumentType[] = [];

  for (const sys of SYSTEM_DOCUMENT_TYPES) {
    if (entity && sys.entity !== entity) continue;
    const o = byKey.get(sys.key);
    result.push({
      key: sys.key,
      entity: sys.entity,
      name: o?.name ?? sys.name,
      expires: o?.expires ?? sys.expires,
      issueDateRequired: o?.issueDateRequired ?? sys.issueDateRequired,
      uploadRequired: o?.uploadRequired ?? sys.uploadRequired,
      // Not overridable — spec §2.
      singleton: sys.singleton,
      sharedByDefault: o?.sharedByDefault ?? sys.sharedByDefault ?? false,
      mirrorField: sys.mirrorField,
      partnerTypeKey: sys.partnerTypeKey,
      isSystem: true,
      hidden: !!o?.hiddenAt,
      sortOrder: o?.sortOrder ?? sys.sortOrder,
    });
  }

  for (const r of rows) {
    if (!r.isCustom) continue;
    if (entity && r.entity !== entity) continue;
    result.push({
      key: r.key,
      entity: r.entity,
      name: r.name ?? r.key,
      expires: r.expires ?? true,
      issueDateRequired: r.issueDateRequired ?? false,
      uploadRequired: r.uploadRequired ?? true,
      singleton: r.singleton ?? true,
      sharedByDefault: r.sharedByDefault ?? false,
      isSystem: false,
      hidden: !!r.hiddenAt,
      sortOrder: r.sortOrder ?? 1000,
    });
  }

  result.sort(
    (a, b) =>
      a.entity.localeCompare(b.entity) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  return result;
}

export async function loadEffectiveCatalog(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
  entity?: DocumentEntity,
): Promise<EffectiveDocumentType[]> {
  const rows = await ctx.db
    .query('documentTypes')
    .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
    .collect();
  return mergeCatalog(rows, entity);
}
