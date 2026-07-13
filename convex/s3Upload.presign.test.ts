import { beforeAll, describe, expect, it } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from './s3Upload';

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
