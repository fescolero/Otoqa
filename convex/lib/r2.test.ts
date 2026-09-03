/**
 * R2 key contract (docs/documents-storage-spec.md §1). The key layout is
 * what per-customer export/purge, bucket tooling, and signed GETs rely
 * on — pin it.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FILENAME_LENGTH,
  buildEntityDocumentKey,
  buildEntityDocumentMetadata,
  isStoredContentType,
  keyFromExternalUrl,
  metadataToHeaders,
  sanitizeFilename,
} from './r2';

describe('sanitizeFilename', () => {
  it('keeps only [A-Za-z0-9.-], collapses runs, and strips leading dots', () => {
    expect(sanitizeFilename('My CDL (front) 2026.pdf')).toBe('My_CDL_front_2026.pdf');
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
  });

  it('never returns an empty string', () => {
    expect(sanitizeFilename('')).toBe('document');
    expect(sanitizeFilename('???')).toBe('document');
  });

  it('caps length while preserving the extension', () => {
    const long = 'a'.repeat(200) + '.jpeg';
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(out.endsWith('.jpeg')).toBe(true);
  });
});

describe('buildEntityDocumentKey', () => {
  it('lays out driver keys org-first with the doc id in the object name', () => {
    expect(
      buildEntityDocumentKey({
        orgId: 'org_A',
        entity: 'driver',
        entityId: 'drv_1',
        typeKey: 'cdl',
        docId: 'doc_9',
        fileName: 'cdl front.pdf',
      }),
    ).toBe('orgs/org_A/drivers/drv_1/cdl/doc_9-cdl_front.pdf');
  });

  it('uses carriers/{partnershipId} and company/ for the other entities', () => {
    expect(
      buildEntityDocumentKey({ orgId: 'org_A', entity: 'carrier', entityId: 'p_1', typeKey: 'coi', docId: 'd', fileName: 'coi.pdf' }),
    ).toBe('orgs/org_A/carriers/p_1/coi/d-coi.pdf');
    expect(
      buildEntityDocumentKey({ orgId: 'org_A', entity: 'organization', entityId: 'org_A', typeKey: 'org_w9', docId: 'd', fileName: 'w9.pdf' }),
    ).toBe('orgs/org_A/company/org_w9/d-w9.pdf');
  });
});

describe('metadata', () => {
  it('uses kebab-case keys and maps to x-amz-meta-* headers verbatim', () => {
    const md = buildEntityDocumentMetadata({
      orgId: 'org_A',
      entity: 'driver',
      entityId: 'drv_1',
      typeKey: 'cdl',
      docId: 'doc_9',
      uploadedVia: 'web',
    });
    expect(md).toEqual({
      'org-id': 'org_A',
      entity: 'driver',
      'entity-id': 'drv_1',
      'doc-id': 'doc_9',
      'doc-type': 'cdl',
      'uploaded-via': 'web',
    });
    expect(metadataToHeaders(md)['x-amz-meta-doc-id']).toBe('doc_9');
  });
});

describe('stored content types', () => {
  it('accepts exactly PDF/JPEG/PNG/WebP, case-insensitively', () => {
    expect(isStoredContentType('application/pdf')).toBe(true);
    expect(isStoredContentType('IMAGE/JPEG')).toBe(true);
    expect(isStoredContentType('image/heic')).toBe(false);
    expect(isStoredContentType('image/gif')).toBe(false);
    expect(isStoredContentType(undefined)).toBe(false);
  });
});

describe('keyFromExternalUrl (legacy rows)', () => {
  it('derives the key from the pathname of r2.dev and custom-domain URLs', () => {
    expect(keyFromExternalUrl('https://pub-abc.r2.dev/orgs/o/loads/l/POD/1-a-b.jpg')).toBe('orgs/o/loads/l/POD/1-a-b.jpg');
    expect(keyFromExternalUrl('https://files.example.com/a%20b.jpg')).toBe('a b.jpg');
    expect(keyFromExternalUrl('not a url')).toBeNull();
  });
});
