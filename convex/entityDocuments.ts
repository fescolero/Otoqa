/**
 * Entity documents — drivers today; carrier partnerships and organizations
 * in phase 2. docs/documents-storage-spec.md §§2–5, §8.
 *
 * Default-runtime half: queries, mutations, the single access rule, mirror
 * writes, the missing-document summary, and audit. The 'use node' half
 * (driverDocuments.ts) owns presign / HEAD / signed GET and calls the
 * internal functions here with the caller's identity intact.
 *
 * Invariants:
 *   • `pending` rows are invisible everywhere except the sweep.
 *   • Singleton types have at most one `active` row per entity.
 *   • Activating a document writes its expiry to the parent's mirror
 *     field; archiving without replacement leaves the mirror alone.
 *   • Every activate / archive / date edit rewrites `missingDocTypeKeys`
 *     on the parent and logs an audit entry on the parent.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { assertOrgPermission, requireCallerIdentity } from './lib/auth';
import { logAudit, type AuditEntityType } from './lib/audit';
import {
  documentEntityValidator,
  effectiveDocumentTypeValidator,
  loadEffectiveCatalog,
} from './lib/documentCatalog';
import type { DocumentEntity } from './lib/documentTypeDefaults';
import {
  MAX_DOCUMENT_BYTES,
  buildEntityDocumentKey,
  isStoredContentType,
  sanitizeFilename,
} from './lib/r2';
import { parseDateString } from './_helpers/dateUtils';
import { computeMissingTypeKeys, type EffectiveDocumentType } from './_helpers/documentStatus';

// ─── Constants ───────────────────────────────────────────────────────────

/** Pending rows older than this are orphans (closed tab between presign
 *  and finalize) and get swept. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

const PERMISSION_AREA: Record<DocumentEntity, string> = {
  driver: 'fleet',
  carrier: 'partners',
  organization: 'settings',
};

const AUDIT_ENTITY: Record<DocumentEntity, AuditEntityType> = {
  driver: 'driver',
  carrier: 'carrierPartnership',
  organization: 'organization',
};

// ─── Validators ──────────────────────────────────────────────────────────

const statusValidator = v.union(v.literal('pending'), v.literal('active'), v.literal('archived'));

export const entityDocumentValidator = v.object({
  _id: v.id('entityDocuments'),
  entity: documentEntityValidator,
  entityId: v.string(),
  typeKey: v.string(),
  status: statusValidator,
  hasFile: v.boolean(),
  fileName: v.optional(v.string()),
  contentType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  issueDate: v.optional(v.string()),
  expirationDate: v.optional(v.string()),
  note: v.optional(v.string()),
  uploadedBy: v.string(),
  uploadedByName: v.optional(v.string()),
  uploadedAt: v.number(),
  activatedAt: v.optional(v.number()),
  archivedAt: v.optional(v.number()),
  archivedBy: v.optional(v.string()),
  archiveNote: v.optional(v.string()),
  supersededById: v.optional(v.id('entityDocuments')),
});

function toPublic(doc: Doc<'entityDocuments'>) {
  return {
    _id: doc._id,
    entity: doc.entity,
    entityId: doc.entityId,
    typeKey: doc.typeKey,
    status: doc.status,
    hasFile: !!doc.externalKey,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    issueDate: doc.issueDate,
    expirationDate: doc.expirationDate,
    note: doc.note,
    uploadedBy: doc.uploadedBy,
    uploadedByName: doc.uploadedByName,
    uploadedAt: doc.uploadedAt,
    activatedAt: doc.activatedAt,
    archivedAt: doc.archivedAt,
    archivedBy: doc.archivedBy,
    archiveNote: doc.archiveNote,
    supersededById: doc.supersededById,
  };
}

// ─── Owner resolution + the one access rule ──────────────────────────────

interface Owner {
  orgId: string;
  entityName: string;
  /** For entities that can be soft-deleted; uploads are refused then. */
  deleted: boolean;
}

/**
 * Resolve who owns an entity. The org ALWAYS comes from the row, never the
 * caller — it is what the R2 key prefix and every permission check trust.
 */
async function resolveOwner(
  ctx: QueryCtx | MutationCtx,
  entity: DocumentEntity,
  entityId: string,
): Promise<Owner | null> {
  switch (entity) {
    case 'driver': {
      const id = ctx.db.normalizeId('drivers', entityId);
      if (!id) return null;
      const driver = await ctx.db.get(id);
      if (!driver) return null;
      return {
        orgId: driver.organizationId,
        entityName: `${driver.firstName} ${driver.lastName}`.trim(),
        deleted: !!driver.isDeleted,
      };
    }
    case 'carrier': {
      const id = ctx.db.normalizeId('carrierPartnerships', entityId);
      if (!id) return null;
      const p = await ctx.db.get(id);
      if (!p) return null;
      return { orgId: p.brokerOrgId, entityName: p.carrierName || p.mcNumber, deleted: false };
    }
    case 'organization':
      return { orgId: entityId, entityName: 'Organization', deleted: false };
  }
}

type Caller = { orgId: string; userId: string; userName?: string; userEmail?: string };

/**
 * THE access rule (spec §8). Owner-org member holding `{area}:{intent}`.
 * Phase 2 adds: broker reading a linked carrier's shared organization
 * documents; driver reading their own. Throws a ConvexError that never
 * reveals whether the entity exists.
 */
export async function assertEntityAccess(
  ctx: QueryCtx | MutationCtx,
  entity: DocumentEntity,
  entityId: string,
  intent: 'view' | 'edit',
): Promise<Caller & { owner: Owner }> {
  const owner = await resolveOwner(ctx, entity, entityId);
  if (!owner) throw new ConvexError('Not found');
  let who: Caller;
  try {
    who = await assertOrgPermission(ctx, owner.orgId, `${PERMISSION_AREA[entity]}:${intent}`);
  } catch (e) {
    // Cross-org callers get the same answer as a missing row.
    const msg = e instanceof ConvexError ? String(e.data) : '';
    if (msg.includes('Not authorized')) throw new ConvexError('Not found');
    throw e;
  }
  return { ...who, owner };
}

export async function canAccessDocument(
  ctx: QueryCtx | MutationCtx,
  doc: Doc<'entityDocuments'>,
  intent: 'view' | 'edit',
): Promise<boolean> {
  try {
    await assertEntityAccess(ctx, doc.entity, doc.entityId, intent);
    return true;
  } catch {
    return false;
  }
}

// ─── Dates ───────────────────────────────────────────────────────────────

function assertDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDateString(value)) {
    throw new ConvexError(`${label} must be a YYYY-MM-DD date`);
  }
  return value;
}

/** Validate user-entered dates against the type's flags. */
function validateDates(
  type: EffectiveDocumentType,
  dates: { issueDate?: string; expirationDate?: string },
): { issueDate?: string; expirationDate?: string } {
  const issueDate = assertDate(dates.issueDate, 'Issue date');
  const expirationDate = assertDate(dates.expirationDate, 'Expiration date');
  if (type.issueDateRequired && !issueDate) throw new ConvexError('Issue date is required');
  if (type.expires && !expirationDate) throw new ConvexError('Expiration date is required');
  return {
    issueDate,
    // A non-expiring type never stores an expiry, so a later flag flip
    // can't resurrect a stale one.
    expirationDate: type.expires ? expirationDate : undefined,
  };
}

// ─── Catalog lookups ─────────────────────────────────────────────────────

async function requireType(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
  entity: DocumentEntity,
  typeKey: string,
): Promise<{ type: EffectiveDocumentType; catalog: EffectiveDocumentType[] }> {
  const catalog = await loadEffectiveCatalog(ctx, orgId, entity);
  const type = catalog.find((t) => t.key === typeKey);
  if (!type) throw new ConvexError('Unknown document type');
  if (type.hidden) throw new ConvexError('This document type is hidden in Settings › Documents');
  return { type, catalog };
}

async function activeDocsFor(
  ctx: QueryCtx | MutationCtx,
  orgId: string,
  entity: DocumentEntity,
  entityId: string,
): Promise<Doc<'entityDocuments'>[]> {
  return ctx.db
    .query('entityDocuments')
    .withIndex('by_entity', (q) =>
      q.eq('workosOrgId', orgId).eq('entity', entity).eq('entityId', entityId).eq('status', 'active'),
    )
    .collect();
}

// ─── Mirrors + summary ───────────────────────────────────────────────────

async function writeMirror(
  ctx: MutationCtx,
  entity: DocumentEntity,
  entityId: string,
  type: EffectiveDocumentType,
  expirationDate: string | undefined,
): Promise<void> {
  if (!type.mirrorField || !type.expires) return;
  if (entity === 'driver') {
    const id = ctx.db.normalizeId('drivers', entityId);
    if (!id) return;
    const driver = await ctx.db.get(id);
    if (!driver) return;
    const field = type.mirrorField as
      | 'licenseExpiration'
      | 'medicalExpiration'
      | 'badgeExpiration'
      | 'twicExpiration';
    if (driver[field] === expirationDate) return;
    await ctx.db.patch(id, { [field]: expirationDate, updatedAt: Date.now() });
    if (field === 'licenseExpiration') {
      await syncOwnerDriverLicense(ctx, driver, expirationDate);
    }
  }
  // carrier mirrors (insuranceExpiration / ownerDriverLicenseExpiration): phase 2.
}

/**
 * Owner-operator drivers mirror their CDL expiry onto every partnership
 * that lists them as owner-driver (same rule drivers.update applies).
 */
async function syncOwnerDriverLicense(
  ctx: MutationCtx,
  driver: Doc<'drivers'>,
  licenseExpiration: string | undefined,
): Promise<void> {
  const orgs = await ctx.db
    .query('organizations')
    .withIndex('by_organization', (q) => q.eq('workosOrgId', driver.organizationId))
    .collect();
  for (const org of orgs) {
    if (!org.isOwnerOperator || org.ownerDriverId !== driver._id) continue;
    // Same carrierOrgId resolution drivers.update uses.
    const carrierOrgId = org.clerkOrgId || org.workosOrgId || org._id;
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', carrierOrgId))
      .collect();
    for (const p of partnerships) {
      await ctx.db.patch(p._id, { ownerDriverLicenseExpiration: licenseExpiration, updatedAt: Date.now() });
    }
  }
}

/** Rewrite the parent's time-independent missing summary. */
export async function recomputeEntitySummary(
  ctx: MutationCtx,
  orgId: string,
  entity: DocumentEntity,
  entityId: string,
  catalog?: EffectiveDocumentType[],
): Promise<string[]> {
  const types = catalog ?? (await loadEffectiveCatalog(ctx, orgId, entity));
  const active = await activeDocsFor(ctx, orgId, entity, entityId);
  const missing = computeMissingTypeKeys(
    types,
    active.map((d) => ({ typeKey: d.typeKey, hasFile: !!d.externalKey })),
  );
  if (entity === 'driver') {
    const id = ctx.db.normalizeId('drivers', entityId);
    if (id) {
      const driver = await ctx.db.get(id);
      const same =
        driver?.missingDocTypeKeys &&
        driver.missingDocTypeKeys.length === missing.length &&
        driver.missingDocTypeKeys.every((k, i) => k === missing[i]);
      if (driver && !same) await ctx.db.patch(id, { missingDocTypeKeys: missing });
    }
  }
  // carrier partnerships: phase 2.
  return missing;
}

// ─── Activation (shared by finalize + date-only) ─────────────────────────

async function activate(
  ctx: MutationCtx,
  args: {
    doc: Doc<'entityDocuments'>;
    type: EffectiveDocumentType;
    catalog: EffectiveDocumentType[];
    who: Caller & { owner: Owner };
    dates: { issueDate?: string; expirationDate?: string };
    note?: string;
    file?: { contentType: string; sizeBytes: number };
  },
): Promise<void> {
  const { doc, type, who } = args;
  const now = Date.now();
  const dates = validateDates(type, args.dates);

  // Singleton: the previous active row is superseded, never deleted.
  let replaced: Doc<'entityDocuments'> | null = null;
  if (type.singleton) {
    const active = await activeDocsFor(ctx, doc.workosOrgId, doc.entity, doc.entityId);
    for (const prev of active) {
      if (prev.typeKey !== doc.typeKey || prev._id === doc._id) continue;
      await ctx.db.patch(prev._id, {
        status: 'archived',
        archivedAt: now,
        archivedBy: who.userId,
        archiveNote: `Replaced ${formatDate(now)}`,
        supersededById: doc._id,
      });
      replaced = prev;
    }
  }

  await ctx.db.patch(doc._id, {
    status: 'active',
    activatedAt: now,
    issueDate: dates.issueDate,
    expirationDate: dates.expirationDate,
    note: args.note?.trim() || undefined,
    ...(args.file ? { contentType: args.file.contentType, sizeBytes: args.file.sizeBytes } : {}),
  });

  await writeMirror(ctx, doc.entity, doc.entityId, type, dates.expirationDate);
  await recomputeEntitySummary(ctx, doc.workosOrgId, doc.entity, doc.entityId, args.catalog);

  await logAudit(ctx, {
    organizationId: doc.workosOrgId,
    entityType: AUDIT_ENTITY[doc.entity],
    entityId: doc.entityId,
    entityName: who.owner.entityName,
    action: replaced ? 'document_replaced' : 'document_uploaded',
    performedBy: who.userId,
    performedByName: who.userName,
    performedByEmail: who.userEmail,
    description: replaced
      ? `Replaced ${type.name}${dates.expirationDate ? ` (expires ${dates.expirationDate})` : ''}`
      : `Added ${type.name}${dates.expirationDate ? ` (expires ${dates.expirationDate})` : ''}`,
    changesBefore: replaced
      ? JSON.stringify({ documentId: replaced._id, expirationDate: replaced.expirationDate })
      : undefined,
    changesAfter: JSON.stringify({ documentId: doc._id, ...dates, fileName: doc.fileName }),
  });
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Internal: presign / finalize plumbing (called from 'use node') ──────

/**
 * Step 1 of an upload. Validates access + type + declared file, inserts
 * the `pending` row, and derives the object key from its id. Returns what
 * the action needs to presign. Runs with the caller's identity.
 */
export const createPending = internalMutation({
  args: {
    entity: documentEntityValidator,
    entityId: v.string(),
    typeKey: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    docId: v.id('entityDocuments'),
    key: v.string(),
    orgId: v.string(),
    contentType: v.string(),
  }),
  handler: async (ctx, args) => {
    const who = await assertEntityAccess(ctx, args.entity, args.entityId, 'edit');
    if (who.owner.deleted) throw new ConvexError('Cannot add documents to a deleted record');
    const { type } = await requireType(ctx, who.orgId, args.entity, args.typeKey);
    void type;
    const contentType = args.contentType.toLowerCase();
    if (!isStoredContentType(contentType)) {
      throw new ConvexError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.');
    }
    if (args.sizeBytes <= 0 || args.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw new ConvexError('File is too large (25 MB max).');
    }
    const fileName = sanitizeFilename(args.fileName);
    const now = Date.now();
    const docId = await ctx.db.insert('entityDocuments', {
      workosOrgId: who.orgId,
      entity: args.entity,
      entityId: args.entityId,
      typeKey: args.typeKey,
      status: 'pending',
      fileName,
      contentType,
      sizeBytes: args.sizeBytes,
      uploadedBy: who.userId,
      uploadedByName: who.userName,
      uploadedAt: now,
    });
    const key = buildEntityDocumentKey({
      orgId: who.orgId,
      entity: args.entity,
      entityId: args.entityId,
      typeKey: args.typeKey,
      docId,
      fileName,
    });
    await ctx.db.patch(docId, { externalKey: key });
    return { docId, key, orgId: who.orgId, contentType };
  },
});

/** What the finalize action needs to verify the object. */
export const getPendingForFinalize = internalQuery({
  args: { docId: v.id('entityDocuments') },
  returns: v.union(
    v.object({
      status: statusValidator,
      key: v.optional(v.string()),
      declaredContentType: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc) return null;
    if (!(await canAccessDocument(ctx, doc, 'edit'))) return null;
    return { status: doc.status, key: doc.externalKey, declaredContentType: doc.contentType };
  },
});

/**
 * Step 3 of an upload. `verified` comes from the action's HEAD on the
 * object — the row is activated with what R2 actually stored, not what
 * the client declared. Idempotent: an already-active row is a no-op.
 */
export const finalize = internalMutation({
  args: {
    docId: v.id('entityDocuments'),
    verified: v.object({ contentType: v.string(), sizeBytes: v.number() }),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.object({ status: statusValidator }),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc) throw new ConvexError('Not found');
    const who = await assertEntityAccess(ctx, doc.entity, doc.entityId, 'edit');
    if (doc.status === 'active') return { status: 'active' as const };
    if (doc.status === 'archived') throw new ConvexError('Document was already archived');
    const { type, catalog } = await requireType(ctx, who.orgId, doc.entity, doc.typeKey);
    await activate(ctx, {
      doc,
      type,
      catalog,
      who,
      dates: { issueDate: args.issueDate, expirationDate: args.expirationDate },
      note: args.note,
      file: args.verified,
    });
    return { status: 'active' as const };
  },
});

/** Drop a pending row (client cancelled, or the object failed
 *  verification). The action deletes the object itself. */
export const discardPending = internalMutation({
  args: { docId: v.id('entityDocuments') },
  returns: v.union(v.object({ key: v.optional(v.string()) }), v.null()),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.status !== 'pending') return null;
    if (!(await canAccessDocument(ctx, doc, 'edit'))) return null;
    await ctx.db.delete(doc._id);
    return { key: doc.externalKey };
  },
});

/** Signed-GET access check. Returns the key and display metadata, or
 *  null on any auth/scope miss so the action fails closed. */
export const getForAccess = internalQuery({
  args: { docId: v.id('entityDocuments') },
  returns: v.union(
    v.object({
      key: v.string(),
      fileName: v.optional(v.string()),
      contentType: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.status === 'pending' || !doc.externalKey) return null;
    if (!(await canAccessDocument(ctx, doc, 'view'))) return null;
    return { key: doc.externalKey, fileName: doc.fileName, contentType: doc.contentType };
  },
});

// ─── Public mutations ────────────────────────────────────────────────────

/** Date-only entry for a type whose `uploadRequired` is false. */
export const createDateOnly = mutation({
  args: {
    entity: documentEntityValidator,
    entityId: v.string(),
    typeKey: v.string(),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.id('entityDocuments'),
  handler: async (ctx, args) => {
    const who = await assertEntityAccess(ctx, args.entity, args.entityId, 'edit');
    if (who.owner.deleted) throw new ConvexError('Cannot add documents to a deleted record');
    const { type, catalog } = await requireType(ctx, who.orgId, args.entity, args.typeKey);
    if (type.uploadRequired) throw new ConvexError(`${type.name} requires a file`);
    const now = Date.now();
    const docId = await ctx.db.insert('entityDocuments', {
      workosOrgId: who.orgId,
      entity: args.entity,
      entityId: args.entityId,
      typeKey: args.typeKey,
      status: 'pending',
      uploadedBy: who.userId,
      uploadedByName: who.userName,
      uploadedAt: now,
    });
    const doc = (await ctx.db.get(docId))!;
    await activate(ctx, {
      doc,
      type,
      catalog,
      who,
      dates: { issueDate: args.issueDate, expirationDate: args.expirationDate },
      note: args.note,
    });
    return docId;
  },
});

/** Archive without replacement → the type drops to Missing; the parent's
 *  mirror keeps its last date (spec §5.3). */
export const archive = mutation({
  args: { docId: v.id('entityDocuments'), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc) throw new ConvexError('Not found');
    const who = await assertEntityAccess(ctx, doc.entity, doc.entityId, 'edit');
    if (doc.status !== 'active') throw new ConvexError('Only active documents can be archived');
    const now = Date.now();
    await ctx.db.patch(doc._id, {
      status: 'archived',
      archivedAt: now,
      archivedBy: who.userId,
      archiveNote: args.note?.trim() || `Archived ${formatDate(now)}`,
    });
    const catalog = await loadEffectiveCatalog(ctx, who.orgId, doc.entity);
    const type = catalog.find((t) => t.key === doc.typeKey);
    await recomputeEntitySummary(ctx, who.orgId, doc.entity, doc.entityId, catalog);
    await logAudit(ctx, {
      organizationId: who.orgId,
      entityType: AUDIT_ENTITY[doc.entity],
      entityId: doc.entityId,
      entityName: who.owner.entityName,
      action: 'document_archived',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Archived ${type?.name ?? doc.typeKey}${args.note ? ` — ${args.note.trim()}` : ''}`,
      changesBefore: JSON.stringify({ documentId: doc._id, expirationDate: doc.expirationDate }),
    });
    return null;
  },
});

/** Edit the dates on an active document (mirror follows). */
export const updateDates = mutation({
  args: {
    docId: v.id('entityDocuments'),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc) throw new ConvexError('Not found');
    const who = await assertEntityAccess(ctx, doc.entity, doc.entityId, 'edit');
    if (doc.status !== 'active') throw new ConvexError('Only active documents can be edited');
    const { type, catalog } = await requireType(ctx, who.orgId, doc.entity, doc.typeKey);
    const dates = validateDates(type, {
      issueDate: args.issueDate ?? doc.issueDate,
      expirationDate: args.expirationDate ?? doc.expirationDate,
    });
    await ctx.db.patch(doc._id, {
      ...dates,
      ...(args.note !== undefined ? { note: args.note.trim() || undefined } : {}),
    });
    await writeMirror(ctx, doc.entity, doc.entityId, type, dates.expirationDate);
    await recomputeEntitySummary(ctx, who.orgId, doc.entity, doc.entityId, catalog);
    await logAudit(ctx, {
      organizationId: who.orgId,
      entityType: AUDIT_ENTITY[doc.entity],
      entityId: doc.entityId,
      entityName: who.owner.entityName,
      action: 'document_dates_changed',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Updated ${type.name} dates`,
      changesBefore: JSON.stringify({ issueDate: doc.issueDate, expirationDate: doc.expirationDate }),
      changesAfter: JSON.stringify(dates),
      changedFields: ['issueDate', 'expirationDate'],
    });
    return null;
  },
});

// ─── Public query ────────────────────────────────────────────────────────

/**
 * Everything the Documents tab needs: the effective catalog for the
 * entity (hidden types included so archived rows of a since-hidden type
 * still label correctly) and every non-pending document.
 */
export const listForEntity = query({
  args: { entity: documentEntityValidator, entityId: v.string() },
  returns: v.object({
    types: v.array(effectiveDocumentTypeValidator),
    documents: v.array(entityDocumentValidator),
    canEdit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const who = await assertEntityAccess(ctx, args.entity, args.entityId, 'view');
    let canEdit = true;
    try {
      await assertOrgPermission(ctx, who.orgId, `${PERMISSION_AREA[args.entity]}:edit`);
    } catch {
      canEdit = false;
    }
    const types = await loadEffectiveCatalog(ctx, who.orgId, args.entity);
    const rows: Doc<'entityDocuments'>[] = [];
    for (const status of ['active', 'archived'] as const) {
      const part = await ctx.db
        .query('entityDocuments')
        .withIndex('by_entity', (q) =>
          q
            .eq('workosOrgId', who.orgId)
            .eq('entity', args.entity)
            .eq('entityId', args.entityId)
            .eq('status', status),
        )
        .collect();
      rows.push(...part);
    }
    rows.sort((a, b) => (b.activatedAt ?? b.uploadedAt) - (a.activatedAt ?? a.uploadedAt));
    return { types, documents: rows.map(toPublic), canEdit };
  },
});

// ─── Maintenance ─────────────────────────────────────────────────────────

/** Cron: delete stale pending rows and their objects. Registered in
 *  crons.ts through the `job()` wrapper. Bounded per tick. */
export const sweepPending = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    const stale = await ctx.db
      .query('entityDocuments')
      .withIndex('by_status_uploadedAt', (q) => q.eq('status', 'pending').lt('uploadedAt', cutoff))
      .take(200);
    for (const doc of stale) {
      await ctx.db.delete(doc._id);
      if (doc.externalKey) {
        await ctx.scheduler.runAfter(0, internal.s3Upload.deleteObject, { key: doc.externalKey });
      }
    }
    if (stale.length > 0) console.log(`[entityDocuments] swept ${stale.length} pending row(s)`);
    return null;
  },
});

/** Scheduled by documentTypes mutations: a catalog change can flip
 *  Missing for every entity of that kind in the org. */
export const recomputeSummariesForOrg = internalMutation({
  args: { orgId: v.string(), entity: documentEntityValidator },
  returns: v.number(),
  handler: async (ctx, args) => {
    if (args.entity !== 'driver') return 0; // carriers: phase 2
    const catalog = await loadEffectiveCatalog(ctx, args.orgId, 'driver');
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.orgId))
      .collect();
    let n = 0;
    for (const d of drivers) {
      if (d.isDeleted) continue;
      await recomputeEntitySummary(ctx, args.orgId, 'driver', d._id, catalog);
      n++;
    }
    return n;
  },
});

/**
 * One-time backfill after deploy: stamp `missingDocTypeKeys` on every
 * driver so list pages stop relying on the "undefined = all missing"
 * fallback. Paged; re-runnable.
 *
 *   npx convex run entityDocuments:backfillDriverSummaries
 */
export const backfillDriverSummaries = internalMutation({
  args: { cursor: v.optional(v.string()), batch: v.optional(v.number()) },
  returns: v.object({ processed: v.number(), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('drivers')
      .paginate({ cursor: args.cursor ?? null, numItems: args.batch ?? 100 });
    const catalogs = new Map<string, EffectiveDocumentType[]>();
    let processed = 0;
    for (const d of page.page) {
      if (d.isDeleted) continue;
      let catalog = catalogs.get(d.organizationId);
      if (!catalog) {
        catalog = await loadEffectiveCatalog(ctx, d.organizationId, 'driver');
        catalogs.set(d.organizationId, catalog);
      }
      await recomputeEntitySummary(ctx, d.organizationId, 'driver', d._id, catalog);
      processed++;
    }
    return { processed, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/** Convenience for tests and the driver page: who the caller is. */
export const whoami = internalQuery({
  args: {},
  returns: v.object({ orgId: v.string(), userId: v.string() }),
  handler: async (ctx) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    return { orgId, userId };
  },
});

export type EntityDocumentsListResult = {
  types: EffectiveDocumentType[];
  documents: ReturnType<typeof toPublic>[];
  canEdit: boolean;
};

export type { Id };
