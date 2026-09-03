/**
 * Entity documents — mutation, access, mirror, summary, and audit rules
 * from docs/documents-storage-spec.md §§2–5, §8. The 'use node' presign
 * actions are not exercised here (they only talk to R2); the internal
 * mutations they call are.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { PENDING_TTL_MS } from './entityDocuments';

const ORG_A = 'org_workos_docs_A';
const ORG_B = 'org_workos_docs_B';

const EDITOR = {
  subject: 'user_docs_editor',
  name: 'Dana Editor',
  org_id: ORG_A,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('fleet', 'edit')],
};
const VIEWER = {
  subject: 'user_docs_viewer',
  org_id: ORG_A,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('fleet', 'view')],
};
const ADMIN = {
  subject: 'user_docs_admin',
  org_id: ORG_A,
  role: 'admin',
  permissions: [...permissionsForLevel('fleet', 'manage'), ...permissionsForLevel('settings', 'manage')],
};
const OUTSIDER = {
  subject: 'user_docs_outsider',
  org_id: ORG_B,
  role: 'admin',
  permissions: [...permissionsForLevel('fleet', 'manage')],
};

async function insertDriver(ctx: MutationCtx, orgId = ORG_A): Promise<Id<'drivers'>> {
  const now = Date.now();
  return ctx.db.insert('drivers', {
    firstName: 'Rosa',
    lastName: 'Medina',
    email: 'r@t.co',
    phone: '+15550009900',
    licenseState: 'CA',
    licenseExpiration: '2026-01-01', // stale mirror from before documents existed
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: orgId,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
}

function setup() {
  const t = convexTest(schema);
  return t;
}

async function uploadCdl(
  t: ReturnType<typeof setup>,
  driverId: Id<'drivers'>,
  expirationDate: string,
  fileName = 'cdl.pdf',
) {
  const asEditor = t.withIdentity(EDITOR as never);
  const pending = await asEditor.mutation(internal.entityDocuments.createPending, {
    entity: 'driver',
    entityId: driverId,
    typeKey: 'cdl',
    fileName,
    contentType: 'application/pdf',
    sizeBytes: 1234,
  });
  await asEditor.mutation(internal.entityDocuments.finalize, {
    docId: pending.docId,
    verified: { contentType: 'application/pdf', sizeBytes: 1234 },
    expirationDate,
  });
  return pending;
}

describe('upload lifecycle', () => {
  it('pending rows are invisible, finalize activates, mirrors, summarizes, audits', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);

    const pending = await asEditor.mutation(internal.entityDocuments.createPending, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'cdl',
      fileName: 'My CDL (front).pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });
    expect(pending.orgId).toBe(ORG_A);
    expect(pending.key).toBe(`orgs/${ORG_A}/drivers/${driverId}/cdl/${pending.docId}-My_CDL_front.pdf`);

    // Pending is excluded from listings; the type is still Missing.
    const before = await asEditor.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    expect(before.documents).toHaveLength(0);
    expect(before.types.some((ty) => ty.key === 'cdl' && ty.isSystem)).toBe(true);

    await asEditor.mutation(internal.entityDocuments.finalize, {
      docId: pending.docId,
      verified: { contentType: 'application/pdf', sizeBytes: 4321 },
      expirationDate: '2030-06-30',
      note: '  renewed  ',
    });

    const after = await asEditor.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    expect(after.documents).toHaveLength(1);
    const doc = after.documents[0];
    expect(doc.status).toBe('active');
    expect(doc.hasFile).toBe(true);
    expect(doc.sizeBytes).toBe(4321); // what R2 holds, not what the client declared
    expect(doc.expirationDate).toBe('2030-06-30');
    expect(doc.note).toBe('renewed');
    expect(after.canEdit).toBe(true);

    const driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.licenseExpiration).toBe('2030-06-30'); // mirror written
    expect(driver?.missingDocTypeKeys).not.toContain('cdl');
    expect(driver?.missingDocTypeKeys).toContain('medical');

    const audit = await t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity_type', (q) => q.eq('organizationId', ORG_A).eq('entityType', 'driver'))
        .collect(),
    );
    expect(audit.map((a) => a.action)).toContain('document_uploaded');
    expect(audit[0].performedBy).toBe(EDITOR.subject);
  });

  it('finalize is idempotent and refuses an archived row', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const pending = await uploadCdl(t, driverId, '2030-01-01');

    const again = await asEditor.mutation(internal.entityDocuments.finalize, {
      docId: pending.docId,
      verified: { contentType: 'application/pdf', sizeBytes: 1 },
      expirationDate: '2031-01-01',
    });
    expect(again.status).toBe('active');
    const list = await asEditor.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0].expirationDate).toBe('2030-01-01'); // no-op

    await asEditor.mutation(api.entityDocuments.archive, { docId: pending.docId });
    await expect(
      asEditor.mutation(internal.entityDocuments.finalize, {
        docId: pending.docId,
        verified: { contentType: 'application/pdf', sizeBytes: 1 },
        expirationDate: '2031-01-01',
      }),
    ).rejects.toThrow(/already archived/);
  });

  it('an expiring type requires the expiration date at finalize', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const pending = await asEditor.mutation(internal.entityDocuments.createPending, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'cdl',
      fileName: 'cdl.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    await expect(
      asEditor.mutation(internal.entityDocuments.finalize, {
        docId: pending.docId,
        verified: { contentType: 'application/pdf', sizeBytes: 10 },
      }),
    ).rejects.toThrow(/Expiration date is required/);
    await expect(
      asEditor.mutation(internal.entityDocuments.finalize, {
        docId: pending.docId,
        verified: { contentType: 'application/pdf', sizeBytes: 10 },
        expirationDate: '30/06/2030',
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('rejects unsupported content types and oversize files at presign', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    await expect(
      asEditor.mutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: driverId,
        typeKey: 'cdl',
        fileName: 'cdl.heic',
        contentType: 'image/heic',
        sizeBytes: 10,
      }),
    ).rejects.toThrow(/Unsupported file type/);
    await expect(
      asEditor.mutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: driverId,
        typeKey: 'cdl',
        fileName: 'cdl.pdf',
        contentType: 'application/pdf',
        sizeBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toThrow(/too large/);
  });
});

describe('replace and archive (spec §3–§5)', () => {
  it('a second singleton upload archives the previous row with supersededById', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const first = await uploadCdl(t, driverId, '2027-01-01');
    const second = await uploadCdl(t, driverId, '2031-01-01', 'cdl-new.pdf');

    const list = await asEditor.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    const active = list.documents.filter((d) => d.status === 'active');
    const archived = list.documents.filter((d) => d.status === 'archived');
    expect(active.map((d) => d._id)).toEqual([second.docId]);
    expect(archived.map((d) => d._id)).toEqual([first.docId]);
    expect(archived[0].supersededById).toBe(second.docId);
    expect(archived[0].archiveNote).toMatch(/^Replaced /);

    const driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.licenseExpiration).toBe('2031-01-01');

    const actions = await t.run(async (ctx) =>
      (await ctx.db.query('auditLog').collect()).map((a) => a.action),
    );
    expect(actions).toContain('document_replaced');
  });

  it('archive without replacement → Missing, mirror keeps the stale date', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const up = await uploadCdl(t, driverId, '2029-03-03');

    await asEditor.mutation(api.entityDocuments.archive, { docId: up.docId, note: 'Lost card' });

    const driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.missingDocTypeKeys).toContain('cdl');
    expect(driver?.licenseExpiration).toBe('2029-03-03'); // stale by design (§5.3)

    const list = await asEditor.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    expect(list.documents[0].status).toBe('archived');
    expect(list.documents[0].archiveNote).toBe('Lost card');
  });

  it('updateDates edits an active row and follows through to the mirror', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const up = await uploadCdl(t, driverId, '2029-03-03');
    await asEditor.mutation(api.entityDocuments.updateDates, { docId: up.docId, expirationDate: '2029-04-04' });
    const driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.licenseExpiration).toBe('2029-04-04');
  });
});

describe('date-only entries and catalog flags', () => {
  // Catalog mutations schedule a summary recompute (runAfter 0). Drive the
  // scheduler deterministically so the recompute lands inside the test.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const drain = (t: ReturnType<typeof setup>) => t.finishAllScheduledFunctions(vi.runAllTimers);

  it('createDateOnly is refused for upload-required types and allowed once the org relaxes the flag', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const asAdmin = t.withIdentity(ADMIN as never);

    await expect(
      asEditor.mutation(api.entityDocuments.createDateOnly, {
        entity: 'driver',
        entityId: driverId,
        typeKey: 'drug_screen',
        issueDate: '2026-01-15',
      }),
    ).rejects.toThrow(/requires a file/);

    await asAdmin.mutation(api.documentTypes.upsertSystemOverride, { key: 'drug_screen', uploadRequired: false });
    await drain(t);
    const catalog = await asEditor.query(api.documentTypes.effectiveCatalog, { entity: 'driver' });
    const ds = catalog.find((c) => c.key === 'drug_screen')!;
    expect(ds.uploadRequired).toBe(false);
    expect(ds.isSystem).toBe(true);
    expect(ds.singleton).toBe(false); // not overridable

    await asEditor.mutation(api.entityDocuments.createDateOnly, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'drug_screen',
      issueDate: '2026-01-15',
    });
    const driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.missingDocTypeKeys).not.toContain('drug_screen');
  });

  it('hidden types drop out of the summary; custom types cannot be deleted while referenced', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asAdmin = t.withIdentity(ADMIN as never);
    const asEditor = t.withIdentity(EDITOR as never);

    await asAdmin.mutation(api.documentTypes.createCustomType, {
      entity: 'driver',
      key: 'clearinghouse',
      name: 'Clearinghouse query',
      expires: false,
      issueDateRequired: true,
      uploadRequired: false,
    });
    await drain(t); // runs recomputeSummariesForOrg
    let driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.missingDocTypeKeys).toContain('clearinghouse');

    await asEditor.mutation(api.entityDocuments.createDateOnly, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'clearinghouse',
      issueDate: '2026-02-02',
    });
    await expect(asAdmin.mutation(api.documentTypes.deleteCustomType, { key: 'clearinghouse' })).rejects.toThrow(
      /hide it instead/,
    );

    await asAdmin.mutation(api.documentTypes.setHidden, { key: 'hazmat', hidden: true });
    await drain(t);
    driver = await t.run((ctx) => ctx.db.get(driverId));
    expect(driver?.missingDocTypeKeys).not.toContain('hazmat');

    await expect(
      asEditor.mutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: driverId,
        typeKey: 'hazmat',
        fileName: 'h.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/hidden/);
  });

  it('system overrides and custom writes need settings:manage', async () => {
    const t = setup();
    const asEditor = t.withIdentity(EDITOR as never);
    await expect(
      asEditor.mutation(api.documentTypes.upsertSystemOverride, { key: 'cdl', uploadRequired: false }),
    ).rejects.toThrow(/settings:manage/);
    await drain(t);
  });
});

describe('access (spec §8)', () => {
  it('cross-org callers see "Not found"; viewers can list but not write', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    await uploadCdl(t, driverId, '2030-01-01');

    const asOutsider = t.withIdentity(OUTSIDER as never);
    await expect(
      asOutsider.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId }),
    ).rejects.toThrow(/Not found/);

    const asViewer = t.withIdentity(VIEWER as never);
    const list = await asViewer.query(api.entityDocuments.listForEntity, { entity: 'driver', entityId: driverId });
    expect(list.documents).toHaveLength(1);
    expect(list.canEdit).toBe(false);
    await expect(
      asViewer.mutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: driverId,
        typeKey: 'cdl',
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/fleet:edit/);

    const docId = list.documents[0]._id;
    const asEditor = t.withIdentity(EDITOR as never);
    expect(await asEditor.query(internal.entityDocuments.getForAccess, { docId })).not.toBeNull();
    expect(await asOutsider.query(internal.entityDocuments.getForAccess, { docId })).toBeNull();
    expect(await t.query(internal.entityDocuments.getForAccess, { docId })).toBeNull(); // unauthenticated
  });

  it('the org prefix comes from the driver row, never the caller', async () => {
    const t = setup();
    const driverInB = await t.run((ctx) => insertDriver(ctx, ORG_B));
    const asEditorA = t.withIdentity(EDITOR as never);
    await expect(
      asEditorA.mutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: driverInB,
        typeKey: 'cdl',
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/Not found/);
  });
});

describe('maintenance', () => {
  it('sweepPending removes stale pending rows and schedules object deletion', async () => {
    const t = setup();
    const driverId = await t.run((ctx) => insertDriver(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const stale = await asEditor.mutation(internal.entityDocuments.createPending, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'cdl',
      fileName: 'old.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });
    const fresh = await asEditor.mutation(internal.entityDocuments.createPending, {
      entity: 'driver',
      entityId: driverId,
      typeKey: 'medical',
      fileName: 'new.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });
    await t.run((ctx) => ctx.db.patch(stale.docId, { uploadedAt: Date.now() - PENDING_TTL_MS - 1000 }));

    await t.mutation(internal.entityDocuments.sweepPending, {});

    expect(await t.run((ctx) => ctx.db.get(stale.docId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(fresh.docId))).not.toBeNull();
  });

  it('backfillDriverSummaries stamps every driver', async () => {
    const t = setup();
    const a = await t.run((ctx) => insertDriver(ctx));
    const b = await t.run((ctx) => insertDriver(ctx));
    const res = await t.mutation(internal.entityDocuments.backfillDriverSummaries, {});
    expect(res.processed).toBe(2);
    expect(res.nextCursor).toBeNull();
    for (const id of [a, b]) {
      const d = await t.run((ctx) => ctx.db.get(id));
      expect(d?.missingDocTypeKeys).toContain('cdl');
    }
  });
});

// ─── Phase 2: carriers, company file, sharing (spec §6) ──────────────────

const BROKER_ORG = 'org_workos_broker_B2';
const CARRIER_ORG = 'org_workos_carrier_B2';
const BROKER_USER = {
  subject: 'user_broker_ops',
  name: 'Bea Broker',
  org_id: BROKER_ORG,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('partners', 'edit')],
};
const BROKER_VIEWER = {
  subject: 'user_broker_viewer',
  org_id: BROKER_ORG,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('partners', 'view')],
};
const CARRIER_ADMIN = {
  subject: 'user_carrier_admin',
  name: 'Cal Carrier',
  org_id: CARRIER_ORG,
  role: 'admin',
  permissions: [...permissionsForLevel('settings', 'manage')],
};
const STRANGER = {
  subject: 'user_stranger',
  org_id: 'org_workos_stranger',
  role: 'admin',
  permissions: [...permissionsForLevel('partners', 'manage')],
};

async function insertCarrierWorld(ctx: MutationCtx, opts: { linked: boolean }) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Rivera Trucking',
    clerkOrgId: 'clerk_rivera',
    workosOrgId: CARRIER_ORG,
    orgType: 'CARRIER',
    billingEmail: 'b@t.co',
    billingAddress: { addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US' },
    subscriptionPlan: 'E',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  });
  const partnershipId = await ctx.db.insert('carrierPartnerships', {
    brokerOrgId: BROKER_ORG,
    // Legacy shape on purpose: the Clerk id, not the WorkOS id.
    ...(opts.linked ? { carrierOrgId: 'clerk_rivera', linkedAt: now } : {}),
    mcNumber: 'MC123',
    carrierName: 'Rivera Trucking',
    status: 'ACTIVE',
    defaultPaymentTerms: 'Net15',
    insuranceExpiration: '2026-02-02', // stale mirror from before documents
    createdAt: now,
    updatedAt: now,
    createdBy: 'u',
  });
  return { orgId, partnershipId };
}

async function uploadFor(
  t: ReturnType<typeof setup>,
  identity: object,
  entity: 'carrier' | 'organization',
  entityId: string,
  typeKey: string,
  dates: { expirationDate?: string; issueDate?: string },
) {
  const as = t.withIdentity(identity as never);
  const pending = await as.mutation(internal.entityDocuments.createPending, {
    entity,
    entityId,
    typeKey,
    fileName: `${typeKey}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 10,
  });
  await as.mutation(internal.entityDocuments.finalize, {
    docId: pending.docId,
    verified: { contentType: 'application/pdf', sizeBytes: 10 },
    ...dates,
  });
  return pending.docId;
}

describe('carrier partnership documents (spec §6.1, §6.3)', () => {
  it("a broker's COI upload mirrors insuranceExpiration and clears the missing summary", async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: false }));
    const asBroker = t.withIdentity(BROKER_USER as never);

    const pending = await asBroker.mutation(internal.entityDocuments.createPending, {
      entity: 'carrier',
      entityId: partnershipId,
      typeKey: 'coi',
      fileName: 'coi.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(pending.key).toBe(`orgs/${BROKER_ORG}/carriers/${partnershipId}/coi/${pending.docId}-coi.pdf`);
    await asBroker.mutation(internal.entityDocuments.finalize, {
      docId: pending.docId,
      verified: { contentType: 'application/pdf', sizeBytes: 10 },
      expirationDate: '2030-09-09',
    });

    const p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.insuranceExpiration).toBe('2030-09-09');
    expect(p?.missingDocTypeKeys).not.toContain('coi');
    expect(p?.missingDocTypeKeys).toContain('w9');

    const list = await asBroker.query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId });
    expect(list.documents).toHaveLength(1);
    expect(list.shared).toHaveLength(0);
    expect(list.linkedCarrierName).toBeUndefined();

    const audit = await t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity_type', (q) => q.eq('organizationId', BROKER_ORG).eq('entityType', 'carrierPartnership'))
        .collect(),
    );
    expect(audit.map((a) => a.action)).toContain('document_uploaded');
  });

  it('archive without replacement keeps the stale insurance mirror (spec §5.3 for carriers)', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: false }));
    const docId = await uploadFor(t, BROKER_USER, 'carrier', partnershipId, 'coi', { expirationDate: '2029-01-01' });
    await t.withIdentity(BROKER_USER as never).mutation(api.entityDocuments.archive, { docId });
    const p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.insuranceExpiration).toBe('2029-01-01');
    expect(p?.missingDocTypeKeys).toContain('coi');
  });

  it('cross-org callers and viewers are gated on partners:*', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: false }));
    await expect(
      t.withIdentity(STRANGER as never).query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId }),
    ).rejects.toThrow(/Not found/);
    const asViewer = t.withIdentity(BROKER_VIEWER as never);
    const list = await asViewer.query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId });
    expect(list.canEdit).toBe(false);
    await expect(
      asViewer.mutation(internal.entityDocuments.createPending, {
        entity: 'carrier',
        entityId: partnershipId,
        typeKey: 'coi',
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/partners:edit/);
  });
});

describe('company file + sharing (spec §6.2)', () => {
  it("a linked carrier's shared COI appears on the broker's partnership, drives its mirror, and can be read by the broker", async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: true }));
    const asCarrier = t.withIdentity(CARRIER_ADMIN as never);
    const asBroker = t.withIdentity(BROKER_USER as never);

    // The carrier's own company file, keyed under orgs/{carrierOrg}/company/.
    const pending = await asCarrier.mutation(internal.entityDocuments.createPending, {
      entity: 'organization',
      entityId: CARRIER_ORG,
      typeKey: 'org_coi',
      fileName: 'coi.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(pending.key).toBe(`orgs/${CARRIER_ORG}/company/org_coi/${pending.docId}-coi.pdf`);
    await asCarrier.mutation(internal.entityDocuments.finalize, {
      docId: pending.docId,
      verified: { contentType: 'application/pdf', sizeBytes: 10 },
      expirationDate: '2031-03-03',
    });

    // Broker side: shared row present, mirror + summary updated (link stored as the Clerk id).
    const list = await asBroker.query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId });
    expect(list.linkedCarrierName).toBe('Rivera Trucking');
    expect(list.shared).toHaveLength(1);
    expect(list.shared[0].partnerTypeKey).toBe('coi');
    expect(list.shared[0].sharedFromOrgName).toBe('Rivera Trucking');
    const p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.insuranceExpiration).toBe('2031-03-03');
    expect(p?.missingDocTypeKeys).not.toContain('coi');

    // Signed-GET access: linked broker yes, stranger no, unauthenticated no.
    expect(await asBroker.query(internal.entityDocuments.getForAccess, { docId: pending.docId })).not.toBeNull();
    expect(await t.withIdentity(STRANGER as never).query(internal.entityDocuments.getForAccess, { docId: pending.docId })).toBeNull();
    expect(await t.query(internal.entityDocuments.getForAccess, { docId: pending.docId })).toBeNull();
    // …and never for edit.
    expect(await asBroker.query(internal.entityDocuments.getPendingForFinalize, { docId: pending.docId })).toBeNull();
  });

  it('latest expiry wins between the broker copy and the shared copy', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: true }));
    await uploadFor(t, CARRIER_ADMIN, 'organization', CARRIER_ORG, 'org_coi', { expirationDate: '2029-01-01' });
    await uploadFor(t, BROKER_USER, 'carrier', partnershipId, 'coi', { expirationDate: '2030-01-01' });
    let p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.insuranceExpiration).toBe('2030-01-01'); // broker's is later

    await uploadFor(t, CARRIER_ADMIN, 'organization', CARRIER_ORG, 'org_coi', { expirationDate: '2032-01-01' });
    p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.insuranceExpiration).toBe('2032-01-01'); // carrier renewed → propagates
  });

  it('withholding a document removes it from linked brokers; only settings:manage may toggle', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: true }));
    const docId = await uploadFor(t, CARRIER_ADMIN, 'organization', CARRIER_ORG, 'org_coi', { expirationDate: '2031-01-01' });
    const asCarrier = t.withIdentity(CARRIER_ADMIN as never);
    const asBroker = t.withIdentity(BROKER_USER as never);

    const own = await asCarrier.query(api.entityDocuments.listForEntity, { entity: 'organization', entityId: CARRIER_ORG });
    expect(own.canShare).toBe(true);
    expect(own.documents[0].shared).toBe(true); // shared by default

    await asCarrier.mutation(api.entityDocuments.setShared, { docId, shared: false });
    const after = await asBroker.query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId });
    expect(after.shared).toHaveLength(0);
    expect(await asBroker.query(internal.entityDocuments.getForAccess, { docId })).toBeNull();
    const p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.missingDocTypeKeys).toContain('coi');
    expect(p?.insuranceExpiration).toBe('2031-01-01'); // stale mirror kept

    const actions = await t.run(async (ctx) => (await ctx.db.query('auditLog').collect()).map((a) => a.action));
    expect(actions).toContain('document_share_changed');

    await expect(asBroker.mutation(api.entityDocuments.setShared, { docId, shared: true })).rejects.toThrow(/Not found/);
  });

  it('an unlinked partnership sees nothing from the carrier org', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: false }));
    await uploadFor(t, CARRIER_ADMIN, 'organization', CARRIER_ORG, 'org_coi', { expirationDate: '2031-01-01' });
    const list = await t
      .withIdentity(BROKER_USER as never)
      .query(api.entityDocuments.listForEntity, { entity: 'carrier', entityId: partnershipId });
    expect(list.shared).toHaveLength(0);
  });

  it('backfillPartnershipSummaries stamps every partnership', async () => {
    const t = setup();
    const { partnershipId } = await t.run((ctx) => insertCarrierWorld(ctx, { linked: true }));
    await uploadFor(t, CARRIER_ADMIN, 'organization', CARRIER_ORG, 'org_w9', { issueDate: '2026-01-01' });
    await t.run((ctx) => ctx.db.patch(partnershipId, { missingDocTypeKeys: undefined }));
    const res = await t.mutation(internal.entityDocuments.backfillPartnershipSummaries, {});
    expect(res.processed).toBe(1);
    const p = await t.run((ctx) => ctx.db.get(partnershipId));
    expect(p?.missingDocTypeKeys).toContain('coi');
    expect(p?.missingDocTypeKeys).not.toContain('w9');
  });
});
