/**
 * Load documents — web/ops upload path and the legacy cleanup
 * (documents-storage-spec.md §9): key-only rows under the load's own
 * prefix, loads:edit gating, no public URL for R2 rows, delete gated.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

const ORG = 'org_workos_loaddocs_A';
const OTHER_ORG = 'org_workos_loaddocs_B';

const EDITOR = {
  subject: 'user_load_editor',
  name: 'Eli Editor',
  org_id: ORG,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('loads', 'edit')],
};
const VIEWER = {
  subject: 'user_load_viewer',
  org_id: ORG,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('loads', 'view')],
};
const OUTSIDER = {
  subject: 'user_load_outsider',
  org_id: OTHER_ORG,
  role: 'admin',
  permissions: [...permissionsForLevel('loads', 'manage')],
};

async function insertLoad(ctx: MutationCtx): Promise<Id<'loadInformation'>> {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  return ctx.db.insert('loadInformation', {
    internalId: 'L-9001',
    orderNumber: 'O-9001',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
}

describe('web upload path', () => {
  it('resolves the org from the load and records a key-only row with audit', async () => {
    const t = convexTest(schema);
    const loadId = await t.run((ctx) => insertLoad(ctx));
    const asEditor = t.withIdentity(EDITOR as never);

    const resolved = await asEditor.query(internal.loadDocuments.resolveLoadForWebUpload, { loadId });
    expect(resolved.orgId).toBe(ORG);

    const key = `orgs/${ORG}/loads/${loadId}/POD/1-abc-pod.pdf`;
    const created = await asEditor.mutation(internal.loadDocuments.createFromWeb, {
      loadId,
      type: 'POD',
      externalKey: key,
      fileName: 'pod.pdf',
      contentType: 'application/pdf',
      note: ' signed BOL ',
    });

    const list = await asEditor.query(api.loadDocuments.listForLoad, { loadId });
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe(created._id);
    expect(list[0].externalKey).toBe(key);
    expect(list[0].externalUrl).toBeUndefined();
    expect(list[0].storageId).toBeUndefined();
    expect(list[0].url).toBeNull(); // no public URL for R2 rows (spec §9)
    expect(list[0].note).toBe('signed BOL');
    expect(list[0].uploadedBy).toBe(EDITOR.subject);

    const audit = await t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity_type', (q) => q.eq('organizationId', ORG).eq('entityType', 'load'))
        .collect(),
    );
    expect(audit.map((a) => a.action)).toContain('document_uploaded');
  });

  it("refuses a key outside the load's own prefix and unsupported types", async () => {
    const t = convexTest(schema);
    const loadId = await t.run((ctx) => insertLoad(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    await expect(
      asEditor.mutation(internal.loadDocuments.createFromWeb, {
        loadId,
        type: 'POD',
        externalKey: `orgs/${OTHER_ORG}/loads/${loadId}/POD/x.pdf`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/Invalid document key/);
    await expect(
      asEditor.mutation(internal.loadDocuments.createFromWeb, {
        loadId,
        type: 'Receipt',
        externalKey: `orgs/${ORG}/loads/${loadId}/POD/x.pdf`, // type segment mismatch
        fileName: 'x.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/Invalid document key/);
    await expect(
      asEditor.mutation(internal.loadDocuments.createFromWeb, {
        loadId,
        type: 'POD',
        externalKey: `orgs/${ORG}/loads/${loadId}/POD/x.heic`,
        fileName: 'x.heic',
        contentType: 'image/heic',
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it('gates presign, record, and delete on loads:edit within the owning org', async () => {
    const t = convexTest(schema);
    const loadId = await t.run((ctx) => insertLoad(ctx));
    const asViewer = t.withIdentity(VIEWER as never);
    const asOutsider = t.withIdentity(OUTSIDER as never);
    const asEditor = t.withIdentity(EDITOR as never);

    await expect(asViewer.query(internal.loadDocuments.resolveLoadForWebUpload, { loadId })).rejects.toThrow(/loads:edit/);
    await expect(asOutsider.query(internal.loadDocuments.resolveLoadForWebUpload, { loadId })).rejects.toThrow(/Load not found/);

    const created = await asEditor.mutation(internal.loadDocuments.createFromWeb, {
      loadId,
      type: 'Other',
      externalKey: `orgs/${ORG}/loads/${loadId}/Other/1-a-b.pdf`,
      fileName: 'b.pdf',
      contentType: 'application/pdf',
    });
    await expect(asViewer.mutation(api.loadDocuments.remove, { documentId: created._id })).rejects.toThrow(/loads:edit/);
    await expect(asOutsider.mutation(api.loadDocuments.remove, { documentId: created._id })).rejects.toThrow(/Document not found/);
    await asEditor.mutation(api.loadDocuments.remove, { documentId: created._id });
    expect(await asEditor.query(api.loadDocuments.listForLoad, { loadId })).toHaveLength(0);
  });
});

describe('assertWebUploadKey (ownership before any storage side effect)', () => {
  it('accepts only a key under a load the caller org owns, for loads:edit callers', async () => {
    const t = convexTest(schema);
    const loadId = await t.run((ctx) => insertLoad(ctx));
    const good = `orgs/${ORG}/loads/${loadId}/POD/1-abc-pod.pdf`;

    const ok = await t.withIdentity(EDITOR as never).query(internal.loadDocuments.assertWebUploadKey, { key: good });
    expect(ok).toEqual({ loadId, orgId: ORG, type: 'POD' });

    // Unauthenticated, wrong org, viewer, foreign key, malformed key — all refused.
    await expect(t.query(internal.loadDocuments.assertWebUploadKey, { key: good })).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER as never).query(internal.loadDocuments.assertWebUploadKey, { key: good }),
    ).rejects.toThrow(/Invalid document key/);
    await expect(
      t.withIdentity(VIEWER as never).query(internal.loadDocuments.assertWebUploadKey, { key: good }),
    ).rejects.toThrow(/loads:edit/);
    await expect(
      t.withIdentity(EDITOR as never).query(internal.loadDocuments.assertWebUploadKey, {
        key: `orgs/${OTHER_ORG}/loads/${loadId}/POD/x.pdf`,
      }),
    ).rejects.toThrow(/Invalid document key/);
    await expect(
      t.withIdentity(EDITOR as never).query(internal.loadDocuments.assertWebUploadKey, {
        key: `orgs/${ORG}/drivers/${loadId}/cdl/x.pdf`,
      }),
    ).rejects.toThrow(/Invalid document key/);
  });

  it('refuses a key an existing document already references — finalize/cancel are for in-flight uploads only', async () => {
    const t = convexTest(schema);
    const loadId = await t.run((ctx) => insertLoad(ctx));
    const asEditor = t.withIdentity(EDITOR as never);
    const recorded = `orgs/${ORG}/loads/${loadId}/POD/1-abc-pod.pdf`;
    await asEditor.mutation(internal.loadDocuments.createFromWeb, {
      loadId,
      type: 'POD',
      externalKey: recorded,
      fileName: 'pod.pdf',
      contentType: 'application/pdf',
    });

    // Neither cancel (delete the bytes behind a recorded row) nor a second
    // row on the same object gets past the ownership check.
    await expect(asEditor.query(internal.loadDocuments.assertWebUploadKey, { key: recorded })).rejects.toThrow(
      /Invalid document key/,
    );
    await expect(
      asEditor.mutation(internal.loadDocuments.createFromWeb, {
        loadId,
        type: 'POD',
        externalKey: recorded,
        fileName: 'pod.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/Invalid document key/);

    // A row an older driver build recorded with only externalUrl is just as recorded.
    const legacyKey = `orgs/${ORG}/loads/${loadId}/POD/3-ghi-photo.jpg`;
    await t.run((ctx) =>
      ctx.db.insert('loadDocuments', {
        loadId,
        workosOrgId: ORG,
        type: 'POD',
        fileName: 'photo.jpg',
        contentType: 'image/jpeg',
        externalUrl: `https://pub-test.r2.dev/${legacyKey}`,
        uploadedBy: 'driver',
        uploadedAt: Date.now(),
      } as never),
    );
    await expect(asEditor.query(internal.loadDocuments.assertWebUploadKey, { key: legacyKey })).rejects.toThrow(
      /Invalid document key/,
    );

    // A fresh key under the same prefix is still an in-flight upload.
    const fresh = `orgs/${ORG}/loads/${loadId}/POD/2-def-pod.pdf`;
    expect(await asEditor.query(internal.loadDocuments.assertWebUploadKey, { key: fresh })).toEqual({
      loadId,
      orgId: ORG,
      type: 'POD',
    });
  });
});
