/**
 * Entity documents — drivers, carrier partnerships, and organizations.
 * docs/documents-storage-spec.md §§2–6, §8.
 *
 * Default-runtime half: queries, mutations, the single access rule, mirror
 * writes, the missing-document summaries, sharing, and audit. The
 * 'use node' half (driverDocuments / carrierDocuments /
 * organizationDocuments, via lib/documentActionHandlers) owns presign /
 * HEAD / signed GET and calls the internal functions here with the
 * caller's identity intact.
 *
 * Invariants:
 *   • `pending` rows are invisible everywhere except the sweep.
 *   • Singleton types have at most one `active` row per entity.
 *   • Activating a document writes its expiry to the parent's mirror
 *     field; archiving without replacement leaves the mirror alone.
 *   • Every activate / archive / date edit / share change rewrites the
 *     parent's `missingDocTypeKeys` and logs an audit entry on the parent.
 *   • A carrier org's `organization` documents that are shared appear on
 *     every linked broker's partnership (read-only, source "carrier");
 *     the partnership's mirrors and summary account for them (§6).
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
import { assertOrgPermission, getCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit, type AuditEntityType } from './lib/audit';
import {
  documentEntityValidator,
  effectiveDocumentTypeValidator,
  loadEffectiveCatalog,
} from './lib/documentCatalog';
import type { DocumentEntity } from './lib/documentTypeDefaults';
import { isOffboarding, orgByAnyId, partnershipSharesDocuments, partnershipsLinkedToOrg } from './lib/orgLookup';
import { logPlatformAudit } from './lib/platformAudit';
import {
  MAX_DOCUMENT_BYTES,
  buildEntityDocumentKey,
  isStoredContentType,
  keyFromExternalUrl,
  sanitizeFilename,
} from './lib/r2';
import { parseDateString } from './_helpers/dateUtils';
import {
  computeMissingTypeKeys,
  pickEffectiveDocument,
  type EffectiveDocumentType,
} from './_helpers/documentStatus';

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

const entityDocumentFields = {
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
  /** organization documents: effective share state (type default merged
   *  with the per-document override). */
  shared: v.optional(v.boolean()),
};

export const entityDocumentValidator = v.object(entityDocumentFields);

/** A linked carrier's shared organization document as seen from a
 *  broker's partnership page. */
export const sharedDocumentValidator = v.object({
  ...entityDocumentFields,
  sharedFromOrgId: v.string(),
  sharedFromOrgName: v.string(),
  /** The `carrier` type key this appears under on the partnership. */
  partnerTypeKey: v.string(),
  typeName: v.string(),
});

type PublicDoc = {
  _id: Id<'entityDocuments'>;
  entity: DocumentEntity;
  entityId: string;
  typeKey: string;
  status: 'pending' | 'active' | 'archived';
  hasFile: boolean;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  issueDate?: string;
  expirationDate?: string;
  note?: string;
  uploadedBy: string;
  uploadedByName?: string;
  uploadedAt: number;
  activatedAt?: number;
  archivedAt?: number;
  archivedBy?: string;
  archiveNote?: string;
  supersededById?: Id<'entityDocuments'>;
  shared?: boolean;
};

function toPublic(doc: Doc<'entityDocuments'>, type?: EffectiveDocumentType): PublicDoc {
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
    // undefined = "sharing does not apply" (not a company document, or a
    // type with no broker counterpart) so the UI offers no toggle.
    shared: doc.entity === 'organization' && isShareableType(type) ? isSharedByRule(doc, type) : undefined,
  };
}

type Ctx = QueryCtx | MutationCtx;

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
async function resolveOwner(ctx: Ctx, entity: DocumentEntity, entityId: string): Promise<Owner | null> {
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
    case 'organization': {
      const org = await orgByAnyId(ctx, entityId);
      return { orgId: entityId, entityName: org?.name ?? 'Company', deleted: !!org?.isDeleted };
    }
  }
}

type Caller = { orgId: string; userId: string; userName?: string; userEmail?: string };

/**
 * THE access rule (spec §8). Owner-org member holding `{area}:{intent}`.
 * Throws a ConvexError that never reveals whether the entity exists.
 */
export async function assertEntityAccess(
  ctx: Ctx,
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

/** Whether an organization document is visible to linked brokers: the
 *  type's default unless the document overrides it. Never true for a
 *  hidden type. */
/** Can documents of this type reach linked brokers at all? Only the
 *  system company types that map onto a carrier type (`partnerTypeKey`);
 *  a custom company type has no counterpart on the broker's side. */
function isShareableType(type: EffectiveDocumentType | undefined): type is EffectiveDocumentType {
  return !!type && !type.hidden && !!type.partnerTypeKey;
}

function isSharedByRule(doc: Doc<'entityDocuments'>, type: EffectiveDocumentType | undefined): boolean {
  if (doc.entity !== 'organization' || !isShareableType(type)) return false;
  return doc.shared ?? type.sharedByDefault;
}

/**
 * Can the caller access this document? Owner-org members with the
 * permission, plus (view only) a broker reading a linked carrier's shared
 * organization document.
 */
export async function canAccessDocument(
  ctx: Ctx,
  doc: Doc<'entityDocuments'>,
  intent: 'view' | 'edit',
): Promise<boolean> {
  try {
    await assertEntityAccess(ctx, doc.entity, doc.entityId, intent);
    return true;
  } catch {
    /* fall through to the sharing path */
  }
  if (intent !== 'view' || doc.entity !== 'organization' || doc.status !== 'active') return false;

  const callerOrgId = await getCallerOrgId(ctx);
  if (!callerOrgId || callerOrgId === doc.workosOrgId) return false;
  try {
    await assertOrgPermission(ctx, callerOrgId, 'partners:view');
  } catch {
    return false;
  }
  const carrierOrg = await orgByAnyId(ctx, doc.workosOrgId);
  if (!carrierOrg || carrierOrg.isDeleted) return false; // same guard as the listing
  const linked = (await partnershipsLinkedToOrg(ctx, carrierOrg)).some(
    (p) => p.brokerOrgId === callerOrgId && partnershipSharesDocuments(p),
  );
  if (!linked) return false;
  const catalog = await loadEffectiveCatalog(ctx, doc.workosOrgId, 'organization');
  return isSharedByRule(doc, catalog.find((t) => t.key === doc.typeKey));
}

// ─── Dates ───────────────────────────────────────────────────────────────

function assertDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  // Shape AND calendar validity: Date.UTC rolls 2026-02-31 over to March,
  // so a round-trip that changes the day is an invalid date.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m || !parseDateString(value)) throw new ConvexError(`${label} must be a YYYY-MM-DD date`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    throw new ConvexError(`${label} is not a real calendar date`);
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

// ─── Catalog + row lookups ───────────────────────────────────────────────

async function requireType(
  ctx: Ctx,
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

async function docsFor(
  ctx: Ctx,
  orgId: string,
  entity: DocumentEntity,
  entityId: string,
  status: 'active' | 'archived',
): Promise<Doc<'entityDocuments'>[]> {
  return ctx.db
    .query('entityDocuments')
    .withIndex('by_entity', (q) =>
      q.eq('workosOrgId', orgId).eq('entity', entity).eq('entityId', entityId).eq('status', status),
    )
    .collect();
}

const activeDocsFor = (ctx: Ctx, orgId: string, entity: DocumentEntity, entityId: string) =>
  docsFor(ctx, orgId, entity, entityId, 'active');

// ─── Sharing (spec §6.2) ─────────────────────────────────────────────────

interface SharedDoc extends PublicDoc {
  sharedFromOrgId: string;
  sharedFromOrgName: string;
  partnerTypeKey: string;
  typeName: string;
  /** raw row, for summary/mirror math (not returned to clients) */
  raw: Doc<'entityDocuments'>;
}

/** The linked carrier org's shared organization documents, mapped onto
 *  the carrier type keys they satisfy on this partnership. Pass `linkedOrg`
 *  when the caller already resolved it (orgByAnyId is up to three reads). */
async function sharedDocsForPartnership(
  ctx: Ctx,
  p: Doc<'carrierPartnerships'>,
  linkedOrg?: Doc<'organizations'> | null,
): Promise<SharedDoc[]> {
  if (!partnershipSharesDocuments(p)) return [];
  const org = linkedOrg === undefined ? await orgByAnyId(ctx, p.carrierOrgId) : linkedOrg;
  if (!org?.workosOrgId || org.isDeleted) return [];
  const catalog = await loadEffectiveCatalog(ctx, org.workosOrgId, 'organization');
  const rows = await activeDocsFor(ctx, org.workosOrgId, 'organization', org.workosOrgId);
  const out: SharedDoc[] = [];
  for (const row of rows) {
    const type = catalog.find((t) => t.key === row.typeKey);
    if (!type?.partnerTypeKey || !isSharedByRule(row, type)) continue;
    out.push({
      ...toPublic(row, type),
      sharedFromOrgId: org.workosOrgId,
      sharedFromOrgName: org.name,
      partnerTypeKey: type.partnerTypeKey,
      typeName: type.name,
      raw: row,
    });
  }
  return out;
}

// ─── Mirrors + summaries ─────────────────────────────────────────────────

async function writeDriverMirror(
  ctx: MutationCtx,
  entityId: string,
  type: EffectiveDocumentType,
  expirationDate: string | undefined,
): Promise<void> {
  if (!type.mirrorField || !type.expires) return;
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

/**
 * Owner-operator drivers mirror their CDL expiry onto every partnership
 * that lists them as owner-driver (same rule drivers.update applies).
 */
async function syncOwnerDriverLicense(
  ctx: MutationCtx,
  driver: Doc<'drivers'>,
  licenseExpiration: string | undefined,
): Promise<void> {
  // Owner-operator drivers store the organizations _id (not the WorkOS
  // id) in organizationId — resolve across every shape, as drivers.update does.
  const org = await orgByAnyId(ctx, driver.organizationId);
  if (!org || !org.isOwnerOperator || org.ownerDriverId !== driver._id) return;
  for (const p of await partnershipsLinkedToOrg(ctx, org)) {
    await ctx.db.patch(p._id, { ownerDriverLicenseExpiration: licenseExpiration, updatedAt: Date.now() });
  }
}

function sameKeys(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Recompute a partnership's `missingDocTypeKeys` and its two mirrors
 * (`insuranceExpiration`, `ownerDriverLicenseExpiration`) from the
 * broker's own active rows PLUS the linked carrier's shared documents.
 * Latest expiry wins (spec §6.3). A type with nothing effective keeps
 * its stale mirror (spec §5.3 applies to carriers too).
 *
 * Exported so carrierPartnerships can call it when a link is made.
 */
export async function recomputePartnershipDocuments(
  ctx: MutationCtx,
  partnershipId: Id<'carrierPartnerships'>,
  catalogIn?: EffectiveDocumentType[],
): Promise<void> {
  const p = await ctx.db.get(partnershipId);
  if (!p) return;
  const catalog = catalogIn ?? (await loadEffectiveCatalog(ctx, p.brokerOrgId, 'carrier'));
  const own = await activeDocsFor(ctx, p.brokerOrgId, 'carrier', p._id);
  const shared = await sharedDocsForPartnership(ctx, p);

  const missing = computeMissingTypeKeys(catalog, [
    ...own.map((d) => ({ typeKey: d.typeKey, hasFile: !!d.externalKey })),
    ...shared.map((s) => ({ typeKey: s.partnerTypeKey, hasFile: s.hasFile })),
  ]);

  const patch: Partial<Doc<'carrierPartnerships'>> = {};
  if (!sameKeys(p.missingDocTypeKeys, missing)) patch.missingDocTypeKeys = missing;

  for (const type of catalog) {
    if (!type.mirrorField || !type.expires || type.hidden) continue;
    const eff = pickEffectiveDocument<{ expirationDate?: string }>(
      type,
      own.filter((d) => d.typeKey === type.key).map((d) => ({ expirationDate: d.expirationDate })),
      shared.filter((s) => s.partnerTypeKey === type.key).map((s) => ({ expirationDate: s.expirationDate })),
    );
    if (!eff?.doc.expirationDate) continue; // nothing effective → keep stale
    const field = type.mirrorField as 'insuranceExpiration' | 'ownerDriverLicenseExpiration';
    if (p[field] !== eff.doc.expirationDate) patch[field] = eff.doc.expirationDate;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(p._id, { ...patch, updatedAt: Date.now() });
  }
}

/** A carrier org's organization documents changed (or its sharing did):
 *  every broker linked to it may see a different effective set. */
async function recomputeLinkedPartnerships(ctx: MutationCtx, orgWorkosId: string): Promise<void> {
  const org = await orgByAnyId(ctx, orgWorkosId);
  if (!org) return;
  for (const p of await partnershipsLinkedToOrg(ctx, org)) {
    await recomputePartnershipDocuments(ctx, p._id);
  }
}

/** Stamp `missingDocTypeKeys` on a freshly created driver so list pages
 *  never fall back to the code default for it. Call right after insert. */
export async function stampNewDriverSummary(
  ctx: MutationCtx,
  orgId: string,
  driverId: Id<'drivers'>,
): Promise<void> {
  await recomputeEntitySummary(ctx, orgId, 'driver', driverId);
}

/** Rewrite the parent's time-independent summary (+ carrier mirrors). */
export async function recomputeEntitySummary(
  ctx: MutationCtx,
  orgId: string,
  entity: DocumentEntity,
  entityId: string,
  catalog?: EffectiveDocumentType[],
): Promise<void> {
  switch (entity) {
    case 'driver': {
      const types = catalog ?? (await loadEffectiveCatalog(ctx, orgId, 'driver'));
      const active = await activeDocsFor(ctx, orgId, 'driver', entityId);
      const missing = computeMissingTypeKeys(
        types,
        active.map((d) => ({ typeKey: d.typeKey, hasFile: !!d.externalKey })),
      );
      const id = ctx.db.normalizeId('drivers', entityId);
      if (!id) return;
      const driver = await ctx.db.get(id);
      if (driver && !sameKeys(driver.missingDocTypeKeys, missing)) {
        await ctx.db.patch(id, { missingDocTypeKeys: missing });
      }
      return;
    }
    case 'carrier': {
      const id = ctx.db.normalizeId('carrierPartnerships', entityId);
      if (id) await recomputePartnershipDocuments(ctx, id, catalog);
      return;
    }
    case 'organization':
      await recomputeLinkedPartnerships(ctx, entityId);
      return;
  }
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
    // A replacement inherits the previous row's explicit share choice.
    ...(replaced && doc.entity === 'organization' && replaced.shared !== undefined ? { shared: replaced.shared } : {}),
    ...(args.file ? { contentType: args.file.contentType, sizeBytes: args.file.sizeBytes } : {}),
  });

  if (doc.entity === 'driver') await writeDriverMirror(ctx, doc.entityId, type, dates.expirationDate);
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
    await requireType(ctx, who.orgId, args.entity, args.typeKey);
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
    if (doc.entity === 'driver') await writeDriverMirror(ctx, doc.entityId, type, dates.expirationDate);
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

/**
 * Share or withhold one of the org's own documents from linked brokers
 * (spec §6.2). Organization documents only; settings:manage.
 */
export const setShared = mutation({
  args: { docId: v.id('entityDocuments'), shared: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.entity !== 'organization') throw new ConvexError('Not found');
    const who = await assertEntityAccess(ctx, 'organization', doc.entityId, 'edit');
    await assertOrgPermission(ctx, who.orgId, 'settings:manage');
    if (doc.status !== 'active') throw new ConvexError('Only active documents can be shared');
    const catalog = await loadEffectiveCatalog(ctx, who.orgId, 'organization');
    const type = catalog.find((t) => t.key === doc.typeKey);
    if (!isShareableType(type)) {
      throw new ConvexError('Only the standard company documents (COI, W-9, operating authority) can be shared with brokers');
    }
    const before = isSharedByRule(doc, type);
    if (before === args.shared && doc.shared === args.shared) return null;
    await ctx.db.patch(doc._id, { shared: args.shared });
    await recomputeLinkedPartnerships(ctx, who.orgId);
    await logAudit(ctx, {
      organizationId: who.orgId,
      entityType: 'organization',
      entityId: who.orgId,
      entityName: who.owner.entityName,
      action: 'document_share_changed',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `${args.shared ? 'Shared' : 'Withheld'} ${type?.name ?? doc.typeKey} ${args.shared ? 'with' : 'from'} linked brokers`,
      changesBefore: JSON.stringify({ shared: before }),
      changesAfter: JSON.stringify({ shared: args.shared }),
    });
    return null;
  },
});

// ─── Public query ────────────────────────────────────────────────────────

/**
 * Everything a Documents tab needs: the effective catalog for the entity
 * (hidden types included so archived rows of a since-hidden type still
 * label correctly), every non-pending document, and — for a partnership
 * — the linked carrier's shared documents.
 */
export const listForEntity = query({
  args: { entity: documentEntityValidator, entityId: v.string() },
  returns: v.object({
    types: v.array(effectiveDocumentTypeValidator),
    documents: v.array(entityDocumentValidator),
    shared: v.array(sharedDocumentValidator),
    canEdit: v.boolean(),
    canShare: v.boolean(),
    /** Partnerships only: the linked carrier org's name, when linked. */
    linkedCarrierName: v.optional(v.string()),
    /** Partnerships only: the linked carrier is leaving the platform;
     *  shared documents vanish at `purgeAt` (spec §7). */
    linkedCarrierOffboarding: v.optional(v.object({ purgeAt: v.number(), startedAt: v.number() })),
  }),
  handler: async (ctx, args) => {
    const who = await assertEntityAccess(ctx, args.entity, args.entityId, 'view');
    let canEdit = true;
    try {
      await assertOrgPermission(ctx, who.orgId, `${PERMISSION_AREA[args.entity]}:edit`);
    } catch {
      canEdit = false;
    }
    let canShare = false;
    if (args.entity === 'organization') {
      try {
        await assertOrgPermission(ctx, who.orgId, 'settings:manage');
        canShare = true;
      } catch {
        canShare = false;
      }
    }

    const types = await loadEffectiveCatalog(ctx, who.orgId, args.entity);
    const typeByKey = new Map(types.map((t) => [t.key, t]));
    const rows = [
      ...(await docsFor(ctx, who.orgId, args.entity, args.entityId, 'active')),
      ...(await docsFor(ctx, who.orgId, args.entity, args.entityId, 'archived')),
    ];
    rows.sort((a, b) => (b.activatedAt ?? b.uploadedAt) - (a.activatedAt ?? a.uploadedAt));

    let shared: SharedDoc[] = [];
    let linkedCarrierName: string | undefined;
    let linkedCarrierOffboarding: { purgeAt: number; startedAt: number } | undefined;
    if (args.entity === 'carrier') {
      const pid = ctx.db.normalizeId('carrierPartnerships', args.entityId);
      const p = pid ? await ctx.db.get(pid) : null;
      if (p && partnershipSharesDocuments(p)) {
        const org = await orgByAnyId(ctx, p.carrierOrgId);
        shared = await sharedDocsForPartnership(ctx, p, org);
        linkedCarrierName = org?.name;
        if (org && isOffboarding(org) && org.purgeAt && org.offboardingStartedAt) {
          linkedCarrierOffboarding = { purgeAt: org.purgeAt, startedAt: org.offboardingStartedAt };
        }
      }
    }

    return {
      types,
      documents: rows.map((r) => toPublic(r, typeByKey.get(r.typeKey))),
      shared: shared.map(({ raw: _raw, ...s }) => {
        void _raw;
        return s;
      }),
      canEdit,
      canShare,
      linkedCarrierName,
      linkedCarrierOffboarding,
    };
  },
});

// ─── Offboarding: Save a copy (spec §7) ──────────────────────────────────

/**
 * Eligibility + source details for copying a carrier-shared document into
 * the broker's own partnership records. Only during the carrier org's
 * offboarding window, only for a document the broker can already read.
 */
export const getSharedForCopy = internalQuery({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    sharedDocId: v.id('entityDocuments'),
    /** Dates the broker supplies when the carrier's copy lacks one the
     *  broker's own type requires. */
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
  },
  returns: v.object({
    srcKey: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    partnerTypeKey: v.string(),
    carrierName: v.string(),
  }),
  handler: async (ctx, args) => {
    await assertEntityAccess(ctx, 'carrier', args.partnershipId, 'edit');
    const p = await ctx.db.get(args.partnershipId);
    if (!p || !partnershipSharesDocuments(p)) throw new ConvexError('This partnership is not linked to a carrier account');
    const org = await orgByAnyId(ctx, p.carrierOrgId);
    if (!org?.workosOrgId) throw new ConvexError('Carrier organization not found');
    if (!isOffboarding(org)) throw new ConvexError('Save a copy is only available while the carrier is offboarding');
    const doc = await ctx.db.get(args.sharedDocId);
    if (!doc || doc.entity !== 'organization' || doc.workosOrgId !== org.workosOrgId || doc.status !== 'active') {
      throw new ConvexError('Document not found');
    }
    if (!doc.externalKey || !doc.contentType) throw new ConvexError('This document has no file to copy');
    const catalog = await loadEffectiveCatalog(ctx, org.workosOrgId, 'organization');
    const type = catalog.find((t) => t.key === doc.typeKey);
    if (!type?.partnerTypeKey || !isSharedByRule(doc, type)) throw new ConvexError('Document is not shared with you');

    // The copy activates under the BROKER's carrier type, whose flags may
    // be stricter than the carrier's — fail here, before any CopyObject,
    // with something the broker can act on.
    const brokerCatalog = await loadEffectiveCatalog(ctx, p.brokerOrgId, 'carrier');
    const brokerType = brokerCatalog.find((t) => t.key === type.partnerTypeKey);
    if (!brokerType || brokerType.hidden) throw new ConvexError(`${type.name} is hidden in your Settings › Documents`);
    const issueDate = args.issueDate ?? doc.issueDate;
    const expirationDate = args.expirationDate ?? doc.expirationDate;
    if (brokerType.expires && !expirationDate) {
      throw new ConvexError(`${brokerType.name} needs an expiration date and the shared copy has none — enter one to save it`);
    }
    if (brokerType.issueDateRequired && !issueDate) {
      throw new ConvexError(`${brokerType.name} needs an issue date and the shared copy has none — enter one to save it`);
    }
    return {
      srcKey: doc.externalKey,
      fileName: doc.fileName ?? 'document',
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes ?? 1,
      issueDate,
      expirationDate: brokerType.expires ? expirationDate : undefined,
      partnerTypeKey: type.partnerTypeKey,
      carrierName: org.name,
    };
  },
});

// ─── Offboarding: purge (spec §7) ────────────────────────────────────────

export const dueForPurge = internalQuery({
  args: { now: v.number() },
  returns: v.array(
    v.object({ organizationId: v.id('organizations'), workosOrgId: v.optional(v.string()), name: v.string() }),
  ),
  handler: async (ctx, args) => {
    // Convex orders `undefined` before every number, so a bare `lte` would
    // spend the page on orgs that have no purgeAt at all. Bound below too.
    const rows = await ctx.db
      .query('organizations')
      .withIndex('by_purgeAt', (q) => q.gte('purgeAt', 1).lte('purgeAt', args.now))
      .take(25);
    return rows
      .filter((o) => o.purgeAt !== undefined && o.offboardingStartedAt && !o.purgedAt)
      .map((o) => ({ organizationId: o._id, workosOrgId: o.workosOrgId, name: o.name }));
  },
});

const PURGE_BATCH = 200;

/**
 * Object keys referenced by the org's load documents that live OUTSIDE
 * the org prefix (legacy `pod-photos/` / `load-documents/` rows). The
 * purge action deletes these BEFORE any row is removed, so a failure
 * between the two steps leaves rows behind (re-listed next run), never
 * unreferenced bytes. Paged. Entity documents never need this — their
 * keys are always built under the prefix.
 */
/** True only while the org is due AND still offboarding. Once `purgeAt`
 *  has passed, cancelOffboarding refuses (spec §7: the purge is committed),
 *  so this is defense in depth for the row/stamp steps — the first
 *  irreversible step (deleting the prefix) can never race a cancel. */
function stillDueForPurge(org: Doc<'organizations'> | null, now: number): org is Doc<'organizations'> {
  return !!org && isOffboarding(org) && org.purgeAt !== undefined && org.purgeAt <= now;
}

export const isStillDueForPurge = internalQuery({
  args: { organizationId: v.id('organizations'), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => stillDueForPurge(await ctx.db.get(args.organizationId), args.now),
});

export const legacyLoadKeysForOrg = internalQuery({
  args: { organizationId: v.id('organizations'), cursor: v.optional(v.string()) },
  returns: v.object({ keys: v.array(v.string()), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org?.workosOrgId || !stillDueForPurge(org, Date.now())) return { keys: [], nextCursor: null };
    const prefix = `orgs/${org.workosOrgId}/`;
    const page = await ctx.db
      .query('loadDocuments')
      .withIndex('by_org', (q) => q.eq('workosOrgId', org.workosOrgId!))
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });
    const keys: string[] = [];
    for (const d of page.page) {
      const key = d.externalKey ?? (d.externalUrl ? keyFromExternalUrl(d.externalUrl) : null);
      if (key && !key.startsWith(prefix)) keys.push(key);
    }
    return { keys, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Delete one batch of the org's document rows. Returns done=true when
 * nothing is left. Convex `_storage` blobs referenced by load documents
 * are deleted in the same transaction as their rows.
 */
export const purgeOrgRows = internalMutation({
  args: { organizationId: v.id('organizations') },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    // Cancelled mid-run → stop touching rows (done=true ends the loop).
    if (!org?.workosOrgId || !stillDueForPurge(org, Date.now())) return { deleted: 0, done: true };
    const orgId = org.workosOrgId;
    let deleted = 0;

    const docs = await ctx.db
      .query('entityDocuments')
      .withIndex('by_entity', (q) => q.eq('workosOrgId', orgId))
      .take(PURGE_BATCH);
    for (const d of docs) {
      await ctx.db.delete(d._id);
      deleted++;
    }
    if (deleted >= PURGE_BATCH) return { deleted, done: false };

    const types = await ctx.db
      .query('documentTypes')
      .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
      .take(PURGE_BATCH - deleted);
    for (const t of types) {
      await ctx.db.delete(t._id);
      deleted++;
    }
    if (deleted >= PURGE_BATCH) return { deleted, done: false };

    const loadDocs = await ctx.db
      .query('loadDocuments')
      .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
      .take(PURGE_BATCH - deleted);
    for (const d of loadDocs) {
      if (d.storageId) await ctx.storage.delete(d.storageId);
      await ctx.db.delete(d._id);
      deleted++;
    }
    return { deleted, done: deleted < PURGE_BATCH };
  },
});

export const markPurged = internalMutation({
  args: { organizationId: v.id('organizations') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org || org.purgedAt) return false;
    const now = Date.now();
    // A cancel that landed mid-run wins: never stamp an org staff kept.
    if (!stillDueForPurge(org, now)) return false;
    await ctx.db.patch(args.organizationId, {
      purgedAt: now,
      purgeAt: undefined, // leave the by_purgeAt range for orgs still due
      isDeleted: true,
      deletedAt: org.deletedAt ?? now,
      deletedBy: org.deletedBy ?? 'platform:offboarding-purge',
      deletionReason: org.deletionReason ?? org.offboardingReason ?? 'Offboarding purge',
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: 'system@otoqa',
      action: 'org_purged',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      after: JSON.stringify({ purgedAt: now }),
      reason: org.offboardingReason ?? 'Offboarding window ended',
    });
    // The carrier's shared documents just vanished for every linked
    // broker — rewrite their partnership summaries/mirrors now rather than
    // on the next unrelated document event.
    if (org.workosOrgId) await recomputeLinkedPartnerships(ctx, org.workosOrgId);
    return true;
  },
});

// ─── Export (spec §7) ────────────────────────────────────────────────────

/**
 * Every document the org owns, for the client-side export zip. Files are
 * fetched one by one through signed GETs; this only lists.
 * settings:manage.
 */
export const listAllForOrgExport = query({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    rows: v.array(
      v.object({
      docId: v.id('entityDocuments'),
      entity: documentEntityValidator,
      entityId: v.string(),
      entityName: v.string(),
      typeKey: v.string(),
      status: statusValidator,
      fileName: v.optional(v.string()),
      contentType: v.optional(v.string()),
      issueDate: v.optional(v.string()),
      expirationDate: v.optional(v.string()),
      uploadedAt: v.number(),
      sizeBytes: v.optional(v.number()),
      }),
    ),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { orgId } = await requireCallerIdentity(ctx);
    await assertOrgPermission(ctx, orgId, 'settings:manage');
    // Paged: archived rows are never deleted, so an old fleet's file is
    // far past one query's read limit. The client walks the cursor.
    const page = await ctx.db
      .query('entityDocuments')
      .withIndex('by_entity', (q) => q.eq('workosOrgId', orgId))
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });
    const names = new Map<string, string>();
    const out = [];
    for (const d of page.page) {
      if (d.status === 'pending' || !d.externalKey) continue;
      const nameKey = `${d.entity}:${d.entityId}`;
      let entityName = names.get(nameKey);
      if (!entityName) {
        entityName = (await resolveOwner(ctx, d.entity, d.entityId))?.entityName ?? d.entityId;
        names.set(nameKey, entityName);
      }
      out.push({
        docId: d._id,
        entity: d.entity,
        entityId: d.entityId,
        entityName,
        typeKey: d.typeKey,
        status: d.status,
        fileName: d.fileName,
        contentType: d.contentType,
        issueDate: d.issueDate,
        expirationDate: d.expirationDate,
        uploadedAt: d.uploadedAt,
        sizeBytes: d.sizeBytes,
      });
    }
    return { rows: out, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Export access: the org-wide export runs under settings:manage alone, so
 * an admin who lacks fleet:view / partners:view can still take the whole
 * file with them. Owner org only — never the sharing path.
 */
export const getForExport = internalQuery({
  args: { docId: v.id('entityDocuments') },
  returns: v.union(v.null(), v.object({ key: v.string(), fileName: v.optional(v.string()) })),
  handler: async (ctx, args) => {
    const { orgId } = await requireCallerIdentity(ctx);
    await assertOrgPermission(ctx, orgId, 'settings:manage');
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.workosOrgId !== orgId || doc.status === 'pending' || !doc.externalKey) return null;
    return { key: doc.externalKey, fileName: doc.fileName };
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
const RECOMPUTE_PAGE = 100;

/**
 * Recompute every entity's summary after a catalog change. Paged and
 * self-scheduling so a large fleet never exceeds one transaction's
 * limits (a failed mutation would leave every summary stale silently).
 * Returns the number processed on THIS page.
 */
export const recomputeSummariesForOrg = internalMutation({
  args: { orgId: v.string(), entity: documentEntityValidator, cursor: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let n = 0;
    let continueCursor: string | null = null;
    switch (args.entity) {
      case 'driver': {
        const catalog = await loadEffectiveCatalog(ctx, args.orgId, 'driver');
        const page = await ctx.db
          .query('drivers')
          .withIndex('by_organization', (q) => q.eq('organizationId', args.orgId))
          .paginate({ cursor: args.cursor ?? null, numItems: RECOMPUTE_PAGE });
        for (const d of page.page) {
          if (d.isDeleted) continue;
          await recomputeEntitySummary(ctx, args.orgId, 'driver', d._id, catalog);
          n++;
        }
        continueCursor = page.isDone ? null : page.continueCursor;
        break;
      }
      case 'carrier': {
        const catalog = await loadEffectiveCatalog(ctx, args.orgId, 'carrier');
        const page = await ctx.db
          .query('carrierPartnerships')
          .withIndex('by_broker', (q) => q.eq('brokerOrgId', args.orgId))
          .paginate({ cursor: args.cursor ?? null, numItems: RECOMPUTE_PAGE });
        for (const p of page.page) {
          await recomputePartnershipDocuments(ctx, p._id, catalog);
          n++;
        }
        continueCursor = page.isDone ? null : page.continueCursor;
        break;
      }
      case 'organization': {
        // A sharing default changed → every linked broker's view changes.
        // One org links to a handful of brokers; no paging needed.
        await recomputeLinkedPartnerships(ctx, args.orgId);
        n = 1;
        break;
      }
    }
    if (continueCursor) {
      await ctx.scheduler.runAfter(0, internal.entityDocuments.recomputeSummariesForOrg, {
        orgId: args.orgId,
        entity: args.entity,
        cursor: continueCursor,
      });
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

/**
 * Phase 2 backfill: stamp `missingDocTypeKeys` (and any effective mirrors
 * from shared carrier documents) on every partnership. Paged; re-runnable.
 *
 *   npx convex run entityDocuments:backfillPartnershipSummaries
 */
export const backfillPartnershipSummaries = internalMutation({
  args: { cursor: v.optional(v.string()), batch: v.optional(v.number()) },
  returns: v.object({ processed: v.number(), nextCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('carrierPartnerships')
      .paginate({ cursor: args.cursor ?? null, numItems: args.batch ?? 50 });
    const catalogs = new Map<string, EffectiveDocumentType[]>();
    let processed = 0;
    for (const p of page.page) {
      let catalog = catalogs.get(p.brokerOrgId);
      if (!catalog) {
        catalog = await loadEffectiveCatalog(ctx, p.brokerOrgId, 'carrier');
        catalogs.set(p.brokerOrgId, catalog);
      }
      await recomputePartnershipDocuments(ctx, p._id, catalog);
      processed++;
    }
    return { processed, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export type { Id };
