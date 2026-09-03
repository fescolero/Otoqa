# Documents & R2 storage — contract and product rules

Status: agreed design, not yet built. Referenced from `convex/s3Upload.ts`
(which pointed at a `docs/r2-storage.md` that never existed).

This document covers three things:

1. The R2 bucket contract every document path must follow.
2. The data model for entity documents (drivers, carriers, organizations).
3. The product rules for status, replacement, sharing, and offboarding.

Load documents (`loadDocuments`, driver-captured POD/receipts/etc.) already
follow §1 and are unchanged by this spec except where noted in §6.

---

## 1. R2 bucket contract

One private bucket, accessed through the S3 API. Credentials live only in
Convex env (`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`R2_ACCOUNT_ID`). The web app never holds bucket credentials; every upload
and download is a short-lived presigned URL minted by a Convex action.

GPS and audit-log archives use a separate AWS bucket with separate
credentials (`convex/gpsArchive.ts`, `convex/auditLogArchive.ts`). Out of
scope here.

### Key layout

Org first, so per-customer export or purge is one prefix operation.

```
orgs/{workosOrgId}/loads/{loadId}/{type}/{ts}-{rand}-{filename}     (exists)
orgs/{workosOrgId}/drivers/{driverId}/{typeKey}/{docId}-{filename}  (new)
orgs/{workosOrgId}/carriers/{partnershipId}/{typeKey}/{docId}-{filename}  (new)
orgs/{workosOrgId}/company/{typeKey}/{docId}-{filename}             (new)
```

- `{workosOrgId}` is always resolved server-side from the owning row
  (load, driver, partnership, or the caller's org). Never from the client.
- New paths embed the Convex document id in the key, so a key is always
  traceable to its row and never collides.
- Filenames are sanitized to `[A-Za-z0-9.-]` and capped at 80 characters.
- Legacy prefixes `pod-photos/` and `load-documents/` are read-only history.

### Object metadata

Every object carries `x-amz-meta-*` metadata: `org-id`, `entity`,
`entity-id`, `doc-id`, `doc-type`, `uploaded-via` (`web` or
`driver-mobile`). Load documents add the GPS/stop fields they carry today.
Metadata keys are kebab-case. Metadata headers are **signed** into the
presigned PUT, so the client must echo them verbatim.

### Rows store keys, never URLs

New tables store `externalKey` only. `externalUrl` on `loadDocuments` is a
legacy field kept for pre-migration rows; do not add it anywhere else.

### Reads

Consumers exchange a document id for a presigned GET that expires in
15 minutes. The access check lives in an internal query next to the table
and fails closed. No public bucket, no public URLs.

### Browser uploads need CORS

Mobile presigned PUTs bypass CORS; browser PUTs do not. The bucket needs a
CORS rule for each web origin allowing `PUT`, the `Content-Type` header,
and every `x-amz-meta-*` header we sign, and exposing `ETag`. This is
bucket configuration and must be applied to every environment before the
web upload path is enabled.

### Upload flow (web)

1. **Presign.** Client calls the entity's presign action with entity id,
   document type, filename, content type, and size. The action:
   - runs a mutation that validates access and the type, and inserts a
     row in status `pending` (this yields the doc id for the key);
   - builds the key and metadata, presigns a PUT (5 minutes);
   - returns `{docId, uploadUrl, metadataHeaders}`.
2. **PUT.** Browser uploads directly to R2 with the signed headers.
3. **Finalize.** Client calls the finalize action with the doc id plus the
   user-entered issue/expiration dates. The action does a `HEAD` on the
   object, rejects size over the limit or a content type outside the
   allowlist (deleting the object), then runs a mutation that activates
   the row, archives the previous active row for singleton types, and
   updates the mirror fields (§4, §5).
4. **Sweep.** A cron deletes `pending` rows older than one hour and their
   objects if any. This is the orphan story for a closed tab.

Limits: 25 MB per file. Allowed types: PDF, JPEG, PNG, HEIC, WebP.

### Deletion

Rows are archived, not deleted (§3). Physical deletion happens only through
org purge (§5.4) and the pending sweep. The existing pattern for load
documents (row first, then a scheduled `DeleteObject`) is kept for purge.

---

## 2. Data model

### `documentTypes` — per-org catalog

Managed on a Settings › Documents page. Each org gets the system defaults
seeded on first use and can add its own.

| Field | Notes |
|---|---|
| `workosOrgId` | owner org |
| `key` | stable slug, e.g. `cdl`, `medical`, `coi`, `w9` |
| `name` | display name |
| `entity` | `driver` \| `carrier` \| `organization` |
| `expires` | boolean. If false the row has an issue date only |
| `issueDateRequired` | boolean |
| `uploadRequired` | boolean. If false a dated entry without a file is allowed |
| `singleton` | boolean. One active per entity (CDL, medical) vs many (drug screens) |
| `sharedByDefault` | `organization` entity only. See §5.2 |
| `mirrorField` | system types only: which row field mirrors the expiry (§4.4, §5.3) |
| `isSystem` | seeded types cannot be deleted, only hidden |
| `sortOrder`, `hiddenAt` | |

Seeded defaults:

- driver: CDL (mirror `licenseExpiration`), Medical certificate (mirror
  `medicalExpiration`), Badge (mirror `badgeExpiration`), TWIC (mirror
  `twicExpiration`), Drug screen (no expiry), I-9 (no expiry), Hazmat
  endorsement, Background check.
- carrier: Certificate of insurance (mirror `insuranceExpiration`), W-9,
  Operating authority, Owner-driver CDL (mirror
  `ownerDriverLicenseExpiration`), Carrier agreement.
- organization: Certificate of insurance, W-9, Operating authority, all
  `sharedByDefault`.

### `entityDocuments` — one table for all three entities

| Field | Notes |
|---|---|
| `workosOrgId` | owning org (who entered it) |
| `entity`, `entityId` | `driver`/driver id, `carrier`/partnership id, `organization`/org id |
| `typeId` | `documentTypes` row |
| `status` | `pending` \| `active` \| `archived` |
| `externalKey`, `fileName`, `contentType`, `sizeBytes` | null when `uploadRequired` is false and no file was attached |
| `issueDate`, `expirationDate` | `YYYY-MM-DD`, user-entered |
| `uploadedBy`, `uploadedAt` | |
| `archivedAt`, `archivedBy`, `archiveNote`, `supersededById` | |
| `shared` | `organization` entity only; overrides `sharedByDefault` |

Indexes: `by_entity` (`workosOrgId`, `entity`, `entityId`, `status`),
`by_type` (`typeId`, `status`), `by_org_status`.

Shared carrier documents are **not** copied into the broker's org. They are
read through a query that joins the linked carrier org's `organization`
documents (§5.2). Copying happens only via "Save a copy" (§5.4).

### Computed status per (entity, type)

| Situation | Status |
|---|---|
| No active row, never had one | **Missing** |
| No active row, previous row archived | **Missing**, with the archived row's expiry shown and its own expired/expiring state as a sub-label |
| Active row, type expires, date in the past | **Expired** |
| Active row, type expires, ≤ 30 days | **Expiring** |
| Active row, type expires, ≤ 60 days | **Warning** |
| Active row, type expires, > 60 days | **Valid** |
| Active row, type does not expire | **On file** |

The summary strip (On file / Valid / Expiring / Expired) gains **Missing**.

---

## 3. Replacement and archive

- A document is a file plus a user-entered date. The system never reads
  dates from the file.
- Uploading a new document of a singleton type requires the new expiry
  (or issue) date in the same form. On finalize the previous active row is
  archived with note `Replaced <date>` and `supersededById` set.
- Archiving without a replacement drops the type to **Missing**. The only
  way back is a new upload with its date.
- The inline "Expires" cell edit on the driver tab is removed for types
  where `uploadRequired` is true. It stays for date-only types.
- Archived rows are retained. Compliance files are never hard-deleted by a
  user action.

---

## 4. Driver rules

1. **Day one is Missing.** Existing drivers have dates but no files. They
   show Missing for every `uploadRequired` type until a file is uploaded.
   No transitional status.
2. **Driver row dates are mirrors.** `licenseExpiration`,
   `medicalExpiration`, `badgeExpiration`, `twicExpiration` are written by
   the document workflow, not edited directly on the Documents tab. They
   keep the drivers list, the mobile APIs, and the partnership sync working
   without change.
3. **Archive without replacement keeps the stale mirror.** The driver row
   keeps its last known date; the Documents tab shows Missing with the
   archived expiry as context. If there was never a date, the mirror stays
   empty. `licenseExpiration` therefore stays a required field.
4. **Mirror mapping** lives on the system document type (`mirrorField`).
5. **The carrier mobile app stops defaulting `licenseExpiration` to one
   year out** when creating a driver. A fabricated date would present as a
   real expiry.
6. Driver-app read access to driver documents is out of scope for phase 1.
   Before enabling it, `resolveAuthenticatedDriver` must scope by org: it
   currently returns the first driver matching the phone across all orgs.

---

## 5. Carrier rules

### 5.1 Ownership follows who entered it

- A broker's upload on a partnership is the broker's record. It lives under
  `orgs/{brokerOrgId}/carriers/{partnershipId}/` and is owned by the broker.
- A carrier org's upload of its own documents is the carrier's record. It
  lives under `orgs/{carrierOrgId}/company/` as an `organization` document.
- The same carrier partnered with several brokers may have a broker-owned
  copy per partnership. That is expected.

### 5.2 Linking shares top-down

- When a partnership has `carrierOrgId` set, the carrier org's
  `organization` documents whose type is `sharedByDefault` and whose
  `shared` flag is not false appear on the broker's partnership Documents
  tab as read-only rows with source **Carrier**.
- The carrier controls sharing on its Settings › Documents page, per
  document. Defaults are shared for compliance types.
- Carrier updates propagate automatically; the broker sees the carrier's
  current active row.
- The broker can always add its own record alongside. The tab shows both
  sources.
- Unlinking removes the carrier-shared rows from the broker's view. The
  broker's own records stay.

### 5.3 Effective status and mirrors

- For a type present from both sources, the effective status uses the
  **latest expiry** across the broker's active row and the carrier's shared
  active row. The row that won is marked as the source.
- `carrierPartnerships.insuranceExpiration` and
  `ownerDriverLicenseExpiration` are mirrors of the effective expiry,
  recomputed whenever either side's active row changes. The existing
  one-way sync from the driver row to `ownerDriverLicenseExpiration` stays.

### 5.4 Offboarding and "Save a copy"

- When an org signals it is leaving the platform, it enters an
  `offboarding` state with `purgeAt = now + 14 days`. Data is retained in
  full during that window in case they return.
- Every broker linked to an offboarding carrier org is notified and sees a
  **Save a copy** action on each carrier-shared row. Saving performs a
  server-side object copy into the broker's partnership prefix and creates
  a broker-owned `entityDocuments` row. "Save a copy" is not shown outside
  the offboarding window.
- At `purgeAt` a job deletes the org's `orgs/{orgId}/` prefix and its rows.
  This is the only automated physical deletion. `convex/platform/support.ts`
  has no storage purge today; this adds one.

---

## 6. Cleanup that ships alongside

- Delete the unused `s3Upload.getUploadUrl` (client-chosen folder, outside
  the org prefix) and the deprecated `s3Upload.getPODUploadUrl`. Neither
  has a caller.
- Stop the `stop.deliveryPhotos` dual-write in `driverMobile.ts` once the
  load detail page's "has POD" check reads `loadDocuments` instead.
- Drop the `externalUrl` fallback from `loadDocuments.listForLoad`'s `url`
  field; consumers already fetch signed URLs on click.
- Remove the unused `loadCarrierDocuments` table.
- Add the storage env vars to `.env.local.example` with comments.
- Load detail's web Upload button uses the same presign/finalize helpers
  with entity `load`, replacing the unused Convex-storage `create` path.

---

## 7. Shared code shape

One small action per entity, sharing low-level helpers. No single generic
presign action: the per-entity argument shapes and access rules differ, and
the mobile client depends on the exact `getLoadDocumentUploadUrl` contract.

```
convex/lib/r2.ts           key builders, metadata → headers, sanitize
convex/s3Upload.ts         createS3Client, presignPut, presignGet, headObject, deleteObject, copyObject
convex/documentTypes.ts    catalog CRUD + seeding
convex/entityDocuments.ts  presign/finalize/archive/list per entity, status computation, mirrors
convex/driverDocuments.ts  thin driver-specific actions (access rule: org member)
convex/carrierDocuments.ts thin partnership + organization actions (access rules: broker org / carrier org, sharing join)
```

---

## 8. Phases

1. **Drivers.** §1 contract, `documentTypes` + seeding, `entityDocuments`,
   driver presign/finalize/archive, driver Documents tab wired (upload with
   date, archive, Missing status, mirrors), Settings › Documents page
   (list + edit flags). CORS applied.
2. **Carriers.** Partnership documents, organization documents, sharing
   join, per-document share toggle, effective status, insurance and
   owner-driver mirrors, carrier Documents tab wired.
3. **Loads + cleanup.** Load detail web upload via shared helpers; §6.
4. **Offboarding.** `offboarding` state, notifications, Save a copy,
   14-day purge job.
