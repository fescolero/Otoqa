import { describe, expect, it } from 'vitest';
import type { EffectiveDocumentType } from '@/convex/_helpers/documentStatus';
import {
  chipForStatus,
  complianceChipForStatus,
  composeDocumentsViewModel,
  formatBytes,
  formatYmd,
  type EntityDocument,
} from '../driver-documents-model';

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

describe('composeDocumentsViewModel', () => {
  const types = [
    type({ key: 'cdl', name: 'CDL', sortOrder: 10 }),
    type({ key: 'medical', name: 'Medical', sortOrder: 20 }),
    type({ key: 'drug_screen', name: 'Drug screen', expires: false, singleton: false, sortOrder: 30 }),
    type({ key: 'hidden', name: 'Hidden', hidden: true }),
  ];

  it('emits one Missing row per visible type with no active document', () => {
    const vm = composeDocumentsViewModel(types, [], today);
    expect(vm.rows.map((r) => [r.id, r.status])).toEqual([
      ['cdl', 'missing'],
      ['medical', 'missing'],
      ['drug_screen', 'missing'],
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

  it('never shows hidden types', () => {
    const vm = composeDocumentsViewModel(types, [doc({ typeKey: 'hidden', expirationDate: '2030-01-01' })], today);
    expect(vm.rows.some((r) => r.type.key === 'hidden')).toBe(false);
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
