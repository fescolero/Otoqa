import { describe, expect, it } from 'vitest';
import type { EffectiveDocumentType } from '@/convex/_helpers/documentStatus';
import {
  chipForStatus,
  complianceChipForStatus,
  composeDocumentsViewModel,
  formatBytes,
  formatYmd,
  type EntityDocument,
  type SharedDocument,
} from '../entity-documents-model';

const today = '2026-05-04';

function type(partial: Partial<EffectiveDocumentType> & { key: string }): EffectiveDocumentType {
  return {
    entity: 'driver',
    name: partial.key,
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    sharedByDefault: false,
    isSystem: true,
    hidden: false,
    sortOrder: 0,
    ...partial,
  };
}

let n = 0;
function doc(partial: Partial<EntityDocument> & { typeKey: string }): EntityDocument {
  n++;
  return {
    _id: `doc_${n}` as EntityDocument['_id'],
    entity: 'driver',
    entityId: 'drv',
    status: 'active',
    hasFile: true,
    uploadedBy: 'u',
    uploadedAt: 1000 + n,
    activatedAt: 1000 + n,
    ...partial,
  };
}

function sharedDoc(partial: Partial<SharedDocument> & { partnerTypeKey: string }): SharedDocument {
  n++;
  return {
    _id: `shared_${n}` as SharedDocument['_id'],
    entity: 'organization',
    entityId: 'org_carrier',
    typeKey: `org_${partial.partnerTypeKey}`,
    status: 'active',
    hasFile: true,
    uploadedBy: 'c',
    uploadedAt: 1000 + n,
    activatedAt: 1000 + n,
    shared: true,
    sharedFromOrgId: 'org_carrier',
    sharedFromOrgName: 'Rivera Trucking',
    typeName: 'Certificate of insurance',
    ...partial,
  };
}

describe('composeDocumentsViewModel', () => {
  const types = [
    type({ key: 'cdl', name: 'CDL', sortOrder: 10 }),
    type({ key: 'medical', name: 'Medical', sortOrder: 20 }),
    type({ key: 'drug_screen', name: 'Drug screen', expires: false, singleton: false, sortOrder: 30 }),
    type({ key: 'hidden', name: 'Hidden', hidden: true }),
  ];

  it('emits one Missing row per visible type with no active document', () => {
    const vm = composeDocumentsViewModel(types, [], today);
    expect(vm.rows.map((r) => [r.id, r.status, r.source])).toEqual([
      ['cdl', 'missing', null],
      ['medical', 'missing', null],
      ['drug_screen', 'missing', null],
    ]);
    expect(vm.counts).toEqual({ total: 3, onFile: 0, valid: 0, expiring: 0, expired: 0, missing: 3 });
    expect(vm.attention).toBe(3);
  });

  it('uses the newest active row for singletons and one row per document otherwise', () => {
    const docs = [
      doc({ typeKey: 'cdl', expirationDate: '2030-01-01', activatedAt: 1 }),
      doc({ typeKey: 'cdl', expirationDate: '2026-05-10', activatedAt: 2 }), // newer → expiring
      doc({ typeKey: 'drug_screen', issueDate: '2026-01-01' }),
      doc({ typeKey: 'drug_screen', issueDate: '2025-01-01' }),
    ];
    const vm = composeDocumentsViewModel(types, docs, today);
    const cdl = vm.rows.find((r) => r.id === 'cdl')!;
    expect(cdl.status).toBe('expiring');
    expect(cdl.doc?.expirationDate).toBe('2026-05-10');
    expect(cdl.source).toBe('own');
    expect(vm.rows.filter((r) => r.type.key === 'drug_screen')).toHaveLength(2);
    expect(vm.rows.filter((r) => r.type.key === 'drug_screen').every((r) => r.status === 'on_file')).toBe(true);
    expect(vm.counts.onFile).toBe(3);
    expect(vm.counts.valid).toBe(2); // on_file counts as valid in the strip
    expect(vm.counts.expiring).toBe(1);
  });

  it('a Missing row carries the most recent archived document as context', () => {
    const docs = [
      doc({ typeKey: 'cdl', status: 'archived', expirationDate: '2024-01-01', archivedAt: 10 }),
      doc({ typeKey: 'cdl', status: 'archived', expirationDate: '2025-01-01', archivedAt: 20 }),
    ];
    const vm = composeDocumentsViewModel(types, docs, today);
    const cdl = vm.rows.find((r) => r.id === 'cdl')!;
    expect(cdl.status).toBe('missing');
    expect(cdl.lastArchived?.expirationDate).toBe('2025-01-01');
    expect(cdl.lastArchivedStatus).toBe('expired');
    expect(vm.archived.map((d) => d.expirationDate)).toEqual(['2025-01-01', '2024-01-01']);
  });

  it('a date-only row on a type that now requires a file is Missing, not also On file', () => {
    const types = [type({ key: 'drug_screen', expires: false, uploadRequired: true, singleton: false })];
    const vm = composeDocumentsViewModel(types, [doc({ typeKey: 'drug_screen', hasFile: false, issueDate: '2026-01-01' })], today);
    expect(vm.rows[0].status).toBe('missing');
    expect(vm.counts.missing).toBe(1);
    expect(vm.counts.onFile).toBe(0);
  });

  it('never shows hidden types', () => {
    const vm = composeDocumentsViewModel(types, [doc({ typeKey: 'hidden', expirationDate: '2030-01-01' })], today);
    expect(vm.rows.some((r) => r.type.key === 'hidden')).toBe(false);
  });
});

describe('carrier partnerships with shared documents (spec §6.3)', () => {
  const carrierTypes = [
    type({ key: 'coi', entity: 'carrier', name: 'Certificate of insurance', sortOrder: 10 }),
    type({ key: 'w9', entity: 'carrier', name: 'W-9', expires: false, sortOrder: 20 }),
  ];

  it('a shared document satisfies a type the broker has nothing for', () => {
    const vm = composeDocumentsViewModel(carrierTypes, [], today, [
      sharedDoc({ partnerTypeKey: 'coi', expirationDate: '2030-01-01' }),
    ]);
    const coi = vm.rows.find((r) => r.id === 'coi')!;
    expect(coi.status).toBe('valid');
    expect(coi.source).toBe('shared');
    expect(coi.ownDoc).toBeNull();
    expect(vm.rows.find((r) => r.id === 'w9')?.status).toBe('missing');
  });

  it('latest expiry wins between own and shared, and the loser stays reachable as ownDoc', () => {
    const own = doc({ typeKey: 'coi', expirationDate: '2026-05-10' }); // expiring
    const vm = composeDocumentsViewModel(carrierTypes, [own], today, [
      sharedDoc({ partnerTypeKey: 'coi', expirationDate: '2031-01-01' }),
    ]);
    const coi = vm.rows.find((r) => r.id === 'coi')!;
    expect(coi.source).toBe('shared');
    expect(coi.status).toBe('valid');
    expect(coi.ownDoc?._id).toBe(own._id);

    const vm2 = composeDocumentsViewModel(carrierTypes, [doc({ typeKey: 'coi', expirationDate: '2032-01-01' })], today, [
      sharedDoc({ partnerTypeKey: 'coi', expirationDate: '2031-01-01' }),
    ]);
    expect(vm2.rows.find((r) => r.id === 'coi')?.source).toBe('own');
  });

  it("non-expiring types prefer the broker's own record over a shared one", () => {
    const own = doc({ typeKey: 'w9', issueDate: '2026-01-01' });
    const vm = composeDocumentsViewModel(carrierTypes, [own], today, [sharedDoc({ partnerTypeKey: 'w9' })]);
    const w9 = vm.rows.find((r) => r.id === 'w9')!;
    expect(w9.source).toBe('own');
    expect(w9.status).toBe('on_file');
  });
});

describe('presentation helpers', () => {
  it('maps statuses to chips with explicit labels', () => {
    expect(chipForStatus('missing')).toEqual({ status: 'danger', label: 'Missing' });
    expect(chipForStatus('needs_date')).toEqual({ status: 'warning', label: 'Needs date' });
    expect(chipForStatus('on_file')).toEqual({ status: 'valid', label: 'On file' });
    expect(chipForStatus('valid').status).toBe('valid');
  });

  it('collapses to the compliance bar vocabulary', () => {
    expect(complianceChipForStatus('missing')).toBe('expired');
    expect(complianceChipForStatus('needs_date')).toBe('expiring');
    expect(complianceChipForStatus('on_file')).toBe('valid');
  });

  it('formats dates and sizes', () => {
    expect(formatYmd('2026-05-04')).toBe('May 4, 2026');
    expect(formatYmd(undefined)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
