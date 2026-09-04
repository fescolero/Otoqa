/**
 * Shared R2 key utilities usable from both the default Convex runtime
 * (loadDocuments / entityDocuments mutations) and 'use node' actions
 * (s3Upload, driverDocuments). No SDK imports here.
 *
 * Bucket contract: docs/documents-storage-spec.md §1.
 */

import { v } from 'convex/values';
import type { DocumentEntity } from './documentTypeDefaults';

/**
 * Derive the R2 object key from a legacy public-URL row. Works for both
 * pub-{account}.r2.dev and custom-domain URLs — the key is the pathname.
 * Returns null (never throws) for malformed or pathless URLs so callers
 * degrade gracefully: deletion skips the object, downloads return no URL.
 */
export function keyFromExternalUrl(externalUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(externalUrl).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

// ─── Stored-format policy ────────────────────────────────────────────────

/** The only content types ever written to the bucket. Images are
 *  normalized (HEIC → JPEG) client-side before presign; see spec §1. */
export const STORED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type StoredContentType = (typeof STORED_CONTENT_TYPES)[number];

export function isStoredContentType(ct: string | undefined | null): ct is StoredContentType {
  return !!ct && (STORED_CONTENT_TYPES as readonly string[]).includes(ct.toLowerCase());
}

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Size rule alone (the browser checks this before any conversion). */
export function fileSizeProblem(sizeBytes: number): string | null {
  if (!(sizeBytes > 0)) return 'File is empty.';
  if (sizeBytes > MAX_DOCUMENT_BYTES) return 'File is too large (25 MB max).';
  return null;
}

/** THE declared-file check every presign runs: stored type + size. */
export function declaredFileProblem(contentType: string, sizeBytes: number): string | null {
  if (!isStoredContentType(contentType)) return 'Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.';
  return fileSizeProblem(sizeBytes);
}

/** Load-document types a web/ops user may upload (no deprecated alias).
 *  One definition for the presign action, the record mutation and the
 *  upload dialog, so the three can never disagree. */
export const WEB_LOAD_DOCUMENT_TYPES = ['POD', 'Receipt', 'Cargo', 'Damage', 'Accident', 'Other'] as const;
export type WebLoadDocumentType = (typeof WEB_LOAD_DOCUMENT_TYPES)[number];
export const webLoadDocTypeValidator = v.union(
  v.literal('POD'),
  v.literal('Receipt'),
  v.literal('Cargo'),
  v.literal('Damage'),
  v.literal('Accident'),
  v.literal('Other'),
);

// ─── Key building ────────────────────────────────────────────────────────

export const MAX_FILENAME_LENGTH = 80;

/**
 * Sanitize a client-supplied filename for use inside an object key:
 * `[A-Za-z0-9.-]` only, no leading dots, capped at MAX_FILENAME_LENGTH
 * with the extension preserved. Never returns an empty string.
 */
export function sanitizeFilename(name: string, fallback = 'document'): string {
  const cleaned = (name || '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/_+(?=\.)/g, '') // "front_.pdf" → "front.pdf"
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 8 ? cleaned.slice(dot) : '';
  const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  return base.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

const ENTITY_SEGMENT: Record<DocumentEntity, string> = {
  driver: 'drivers',
  carrier: 'carriers',
  organization: 'company',
};

/**
 * Canonical object key for an entity document:
 *
 *   orgs/{orgId}/drivers/{driverId}/{typeKey}/{docId}-{filename}
 *   orgs/{orgId}/carriers/{partnershipId}/{typeKey}/{docId}-{filename}
 *   orgs/{orgId}/company/{typeKey}/{docId}-{filename}
 *
 * The doc id makes every key traceable to its row and collision-free.
 * `orgId` MUST come from the owning row server-side, never the client.
 */
export function buildEntityDocumentKey(parts: {
  orgId: string;
  entity: DocumentEntity;
  entityId: string;
  typeKey: string;
  docId: string;
  fileName: string;
}): string {
  const file = sanitizeFilename(parts.fileName);
  const scope =
    parts.entity === 'organization'
      ? `${ENTITY_SEGMENT.organization}`
      : `${ENTITY_SEGMENT[parts.entity]}/${parts.entityId}`;
  return `orgs/${parts.orgId}/${scope}/${parts.typeKey}/${parts.docId}-${file}`;
}

/**
 * Object metadata for an entity document. Keys are kebab-case because S3
 * lowercases user metadata and strips `x-amz-meta-` on read. The values
 * are signed into the presigned PUT; the client must echo them verbatim.
 */
export function buildEntityDocumentMetadata(parts: {
  orgId: string;
  entity: DocumentEntity;
  entityId: string;
  typeKey: string;
  docId: string;
  uploadedVia: 'web' | 'driver-mobile';
}): Record<string, string> {
  return {
    'org-id': parts.orgId,
    entity: parts.entity,
    'entity-id': parts.entityId,
    'doc-id': parts.docId,
    'doc-type': parts.typeKey,
    'uploaded-via': parts.uploadedVia,
  };
}

/** Translate a metadata map into the request headers a client must send
 *  on PUT (`x-amz-meta-*`). */
export function metadataToHeaders(metadata: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    headers[`x-amz-meta-${k}`] = v;
  }
  return headers;
}
