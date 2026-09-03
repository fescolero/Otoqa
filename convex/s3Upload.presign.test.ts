import { beforeAll, describe, expect, it } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client, presignGet, presignPutWithMetadata } from './s3Upload';
import { buildEntityDocumentKey, buildEntityDocumentMetadata, metadataToHeaders } from './lib/r2';

/**
 * Regression pin for the R2 presigned-PUT contract.
 *
 * AWS SDK >= 3.729 defaults flexible checksums to WHEN_SUPPORTED, which
 * bakes `x-amz-checksum-crc32=AAAAAA==` (the CRC of an EMPTY body) into
 * presigned PUT URLs — R2 then rejects every real upload with a checksum
 * mismatch. That default broke all driver photo uploads once. These
 * tests fail loudly if a future SDK bump or refactor reintroduces it,
 * and pin the signed-metadata-headers contract the shipped mobile
 * clients rely on (they echo x-amz-meta-* as request headers, so those
 * names MUST be in SignedHeaders, not hoisted to the query string).
 */

const METADATA = {
  'org-id': 'org_test',
  'load-id': 'load_test',
  'doc-type': 'POD',
  'uploaded-via': 'driver-mobile',
};

beforeAll(() => {
  process.env.S3_BUCKET = 'driver-uploads-test';
  process.env.S3_ACCESS_KEY_ID = 'AKIATESTFAKEKEY';
  process.env.S3_SECRET_ACCESS_KEY = 'test-fake-secret';
  process.env.R2_ACCOUNT_ID = 'testaccountid';
});

async function presignPut(): Promise<URL> {
  const { client, bucket } = createS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: 'orgs/org_test/loads/load_test/POD/1-abc-pod.jpg',
    ContentType: 'image/jpeg',
    Metadata: METADATA,
  });
  const unhoistableHeaders = new Set(Object.keys(METADATA).map((k) => `x-amz-meta-${k}`));
  const url = await getSignedUrl(client, command, { expiresIn: 300, unhoistableHeaders });
  return new URL(url);
}

describe('R2 presigned PUT contract', () => {
  it('embeds no implicit checksum parameters (R2 rejects empty-body CRCs)', async () => {
    const url = await presignPut();
    for (const param of url.searchParams.keys()) {
      expect(param.toLowerCase()).not.toMatch(/^x-amz-checksum-/);
      expect(param.toLowerCase()).not.toBe('x-amz-sdk-checksum-algorithm');
    }
  });

  it('signs the x-amz-meta-* headers the mobile client echoes on PUT', async () => {
    const url = await presignPut();
    const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    for (const key of Object.keys(METADATA)) {
      expect(signedHeaders).toContain(`x-amz-meta-${key}`);
      // And NOT hoisted into the query string, where the client's echoed
      // header would count as an unsigned x-amz-* header (403).
      expect(url.searchParams.get(`x-amz-meta-${key}`)).toBeNull();
    }
  });
});

describe('entity-document presign helpers (documents-storage-spec.md §1)', () => {
  const metadata = buildEntityDocumentMetadata({
    orgId: 'org_test',
    entity: 'driver',
    entityId: 'drv_1',
    typeKey: 'cdl',
    docId: 'doc_1',
    uploadedVia: 'web',
  });
  const key = buildEntityDocumentKey({
    orgId: 'org_test',
    entity: 'driver',
    entityId: 'drv_1',
    typeKey: 'cdl',
    docId: 'doc_1',
    fileName: 'cdl.pdf',
  });

  it('presignPutWithMetadata signs every metadata header and adds no checksum params', async () => {
    const url = new URL(await presignPutWithMetadata({ key, contentType: 'application/pdf', metadata }));
    expect(url.pathname.endsWith('/orgs/org_test/drivers/drv_1/cdl/doc_1-cdl.pdf')).toBe(true);
    const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    for (const header of Object.keys(metadataToHeaders(metadata))) {
      expect(signedHeaders).toContain(header);
      expect(url.searchParams.get(header)).toBeNull();
    }
    for (const param of url.searchParams.keys()) {
      expect(param.toLowerCase()).not.toMatch(/^x-amz-checksum-/);
    }
  });

  it('presignGet forces attachment disposition only when asked', async () => {
    const view = new URL((await presignGet({ key })).url);
    expect(view.searchParams.get('response-content-disposition')).toBeNull();
    const dl = new URL((await presignGet({ key, downloadAs: 'my "cdl".pdf' })).url);
    expect(dl.searchParams.get('response-content-disposition')).toBe('attachment; filename="my cdl.pdf"');
  });
});
