/**
 * System document types — the code-owned half of the documents catalog.
 *
 * See docs/documents-storage-spec.md §2. There is no per-org seeding:
 * these constants are merged with an org's `documentTypes` rows (overrides
 * of a system key, or fully custom types) into the *effective* catalog by
 * `documentTypes.effectiveCatalog`. Anything an org must not be able to
 * change lives only here — `mirrorField` (which parent-row date the
 * active document writes through to) and `singleton` (one active row per
 * entity vs many).
 *
 * Plain TypeScript, no Convex imports, so the web app can import it too.
 */

export type DocumentEntity = 'driver' | 'carrier' | 'organization';

export type DriverMirrorField =
  | 'licenseExpiration'
  | 'medicalExpiration'
  | 'badgeExpiration'
  | 'twicExpiration';

export type CarrierMirrorField = 'insuranceExpiration' | 'ownerDriverLicenseExpiration';

export type MirrorField = DriverMirrorField | CarrierMirrorField;

export interface SystemDocumentType {
  key: string;
  entity: DocumentEntity;
  name: string;
  /** Whether the document carries an expiration date. */
  expires: boolean;
  /** Whether an issue date must be entered. */
  issueDateRequired: boolean;
  /** Whether a file must be attached for the entry to count. */
  uploadRequired: boolean;
  /** One active row per entity (CDL, medical) vs many (drug screens). */
  singleton: boolean;
  /** `organization` entity only — visible to linked brokers unless a
   *  document opts out. */
  sharedByDefault?: boolean;
  /** Parent-row date field the active document's expiry mirrors into. */
  mirrorField?: MirrorField;
  /** `organization` entity only — the `carrier` type key this document
   *  appears under on a linked broker's partnership page when shared
   *  (documents-storage-spec.md §6.2). */
  partnerTypeKey?: string;
  sortOrder: number;
}

export const SYSTEM_DOCUMENT_TYPES: readonly SystemDocumentType[] = [
  // ─── Driver ────────────────────────────────────────────────────────────
  {
    key: 'cdl',
    entity: 'driver',
    name: 'CDL',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'licenseExpiration',
    sortOrder: 10,
  },
  {
    key: 'medical',
    entity: 'driver',
    name: 'Medical certificate',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'medicalExpiration',
    sortOrder: 20,
  },
  {
    key: 'badge',
    entity: 'driver',
    name: 'Badge',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'badgeExpiration',
    sortOrder: 30,
  },
  {
    key: 'twic',
    entity: 'driver',
    name: 'TWIC card',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'twicExpiration',
    sortOrder: 40,
  },
  {
    key: 'hazmat',
    entity: 'driver',
    name: 'Hazmat endorsement',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    sortOrder: 50,
  },
  {
    key: 'drug_screen',
    entity: 'driver',
    name: 'Drug screen',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: false,
    sortOrder: 60,
  },
  {
    key: 'i9',
    entity: 'driver',
    name: 'I-9',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sortOrder: 70,
  },
  {
    key: 'background_check',
    entity: 'driver',
    name: 'Background check',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: false,
    sortOrder: 80,
  },

  // ─── Carrier (partnership) ─────────────────────────────────────────────
  {
    key: 'coi',
    entity: 'carrier',
    name: 'Certificate of insurance',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'insuranceExpiration',
    sortOrder: 10,
  },
  {
    key: 'w9',
    entity: 'carrier',
    name: 'W-9',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sortOrder: 20,
  },
  {
    key: 'operating_authority',
    entity: 'carrier',
    name: 'Operating authority',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sortOrder: 30,
  },
  {
    key: 'owner_driver_cdl',
    entity: 'carrier',
    name: 'Owner-driver CDL',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    mirrorField: 'ownerDriverLicenseExpiration',
    sortOrder: 40,
  },
  {
    key: 'carrier_agreement',
    entity: 'carrier',
    name: 'Carrier agreement',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sortOrder: 50,
  },

  // ─── Organization (own compliance file) ────────────────────────────────
  {
    key: 'org_coi',
    entity: 'organization',
    name: 'Certificate of insurance',
    expires: true,
    issueDateRequired: false,
    uploadRequired: true,
    singleton: true,
    sharedByDefault: true,
    partnerTypeKey: 'coi',
    sortOrder: 10,
  },
  {
    key: 'org_w9',
    entity: 'organization',
    name: 'W-9',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sharedByDefault: true,
    partnerTypeKey: 'w9',
    sortOrder: 20,
  },
  {
    key: 'org_operating_authority',
    entity: 'organization',
    name: 'Operating authority',
    expires: false,
    issueDateRequired: true,
    uploadRequired: true,
    singleton: true,
    sharedByDefault: true,
    partnerTypeKey: 'operating_authority',
    sortOrder: 30,
  },
];

export function systemTypesFor(entity: DocumentEntity): SystemDocumentType[] {
  return SYSTEM_DOCUMENT_TYPES.filter((t) => t.entity === entity);
}

export function systemTypeByKey(key: string): SystemDocumentType | undefined {
  return SYSTEM_DOCUMENT_TYPES.find((t) => t.key === key);
}

/** Driver mirror field → system type key. Used by list-page attention
 *  counting so a type that is Missing is not also counted as expired via
 *  its stale mirror. */
export const DRIVER_MIRROR_TO_TYPE_KEY: Record<DriverMirrorField, string> = {
  licenseExpiration: 'cdl',
  medicalExpiration: 'medical',
  badgeExpiration: 'badge',
  twicExpiration: 'twic',
};

/** Custom type keys are org-scoped slugs; they must never collide with a
 *  system key and must be safe to embed in an R2 object key. */
export const CUSTOM_TYPE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** Carrier mirror field → carrier type key (for partnership attention). */
export const CARRIER_MIRROR_TO_TYPE_KEY: Record<CarrierMirrorField, string> = {
  insuranceExpiration: 'coi',
  ownerDriverLicenseExpiration: 'owner_driver_cdl',
};
