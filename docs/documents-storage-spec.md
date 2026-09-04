# Documents & R2 storage — contract and product rules

Status: agreed design, reviewed against the codebase. All four phases are
built and on main (drivers; carriers + company file + sharing; load web
upload + legacy cleanup; offboarding with Save a copy, export, and the
14-day purge).
Referenced from `convex/s3Upload.ts` (which pointed at a
`docs/r2-storage.md` that never existed).

This document covers:

1. The R2 bucket contract every document path must follow.
2. The data model for entity documents (drivers, carriers, organizations).
3. Status computation and the one place it lives.
4. Replacement and archive rules.
5. Driver rules. 6. Carrier rules. 7. Offboarding.
8. Access, permissions, audit. 9. Cleanup. 10. Code shape. 11. Testing.
12. Phases.

Load documents (`loadDocuments`, driver-captured POD/receipts/etc.) already
follow §1 and are unchanged except where §9 says otherwise.

---

## 1. R2 bucket contract

One private bucket per Convex deployment (dev, preview, prod each get
their own bucket and CORS rule; never point a dev deployment at the prod
bucket). Accessed through the S3 API. Credentials live only in Convex env
(`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`).
The web app never holds bucket credentials; every upload and download is
a short-lived presigned URL minted by a Convex action.

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
15 minutes. The access check is `canAccessDocument` (§8) and fails closed.
Downloads (as opposed to previews) presign with
`ResponseContentDisposition: attachment` so a file is never rendered as a
page. No public bucket, no public URLs.

### Browser uploads need CORS

Mobile presigned PUTs bypass CORS; browser PUTs do not. Each bucket needs
a CORS rule listing the web origins for that deployment (local dev, the
preview domain, prod) allowing `PUT`, the `Content-Type` header, and every
`x-amz-meta-*` header we sign, and exposing `ETag`. Confirm whether R2
accepts a wildcard origin for Vercel preview deployments; if not, previews
use a fixed preview domain. This is bucket configuration and must be
applied before the web upload path is enabled in that environment.

### Upload flow (web)

1. **Presign.** Client calls the entity's presign action with entity id,
   document type key, filename, content type, and size. The action:
   - runs a mutation that checks permission (§8), validates the type
     against the effective catalog (§2), and inserts a row in status
     `pending` (this yields the doc id for the key);
   - builds the key and metadata, presigns a PUT (5 minutes);
   - returns `{docId, uploadUrl, metadataHeaders}`.
2. **PUT.** Browser uploads directly to R2 with the signed headers.
3. **Finalize.** Client calls the finalize action with the doc id plus the
   user-entered issue/expiration dates. The action does a `HEAD` on the
   object, rejects size over the limit or a content type outside the
   allowlist (deleting the object), then runs a mutation that activates
   the row, archives the previous active row for singleton types, updates
   the mirror fields (§5, §6), recomputes the entity's missing-types
   summary (§3), and writes an audit entry (§8). Finalize is idempotent:
   a row that is already `active` returns success without side effects.
4. **Sweep.** A cron registered through the `job()` wrapper in
   `convex/crons.ts` deletes `pending` rows older than one hour and their
   objects if any. This is the orphan story for a closed tab. `pending`
   rows are excluded from every listing and from status.

Limits: 25 MB per file. Stored formats: PDF, JPEG, PNG, WebP. Nothing
else is ever written to the bucket; the finalize `HEAD` check rejects
anything outside this list.

### Image normalization (HEIC and friends)

Every image is converted to a renderable format **before** it is
uploaded, and the converted file is what gets stored. Nothing downstream
(preview modal, signed downloads, Save a copy, export) ever has to handle
a camera-native format.

- **Driver app.** All four capture paths are camera captures, which emit
  JPEG, and each runs `prepareImageForUpload`. That helper only re-encodes
  when the long edge exceeds 2000px and returns the original file
  untouched otherwise or on any error, and the upload hard-codes
  `image/jpeg` as the content type regardless of the bytes. Harden it:
  always re-encode to JPEG when the source is not already JPEG (by
  extension or reported mime), keep the resize skip as a format-only
  pass, and never fall through with a non-JPEG file. This closes the hole
  before a photo-library picker or a HEIC-emitting device ever appears.
- **Web app.** A HEIC reaches the web when ops uploads a photo a driver
  sent them. Convert it in the browser before presign using a lazily
  loaded libheif WebAssembly build (`heic2any`), output JPEG, and present
  the converted file's name and type to the presign call. The library is
  loaded only when a HEIC/HEIF file is selected, so nobody else pays for
  it. Conversion takes a few seconds on large files; show progress.
  Server-side conversion is not viable: Convex Node actions cannot run
  native image libraries, hosted `sharp` builds lack HEVC decoding, and
  Cloudflare's image transforms cannot read a private bucket.
- **Enforcement.** The web file picker accepts PDF, JPEG, PNG, WebP, HEIC,
  and HEIF; the presign action accepts only the stored formats. If a HEIC
  ever bypasses conversion, presign refuses it with a clear error and
  nothing is written.

### Deletion

Rows are archived, not deleted (§4). Physical deletion happens only through
org purge (§7) and the pending sweep. The existing pattern (row first, then
a scheduled `DeleteObject`) is kept for purge.

Malware scanning is out of scope and recorded as accepted debt. The
content-type allowlist, private bucket, and attachment disposition are the
mitigations.

---

## 2. Data model

### Document types: code defaults plus per-org overrides

There is **no per-org seeding**. Convex has no org-creation hook (orgs are
inserted in four places in `carrierPartnerships.ts` alone) and queries
cannot write, so a "seed on first read" design would either race or never
run. Instead:

- **System types** are code constants in
  `convex/lib/documentTypeDefaults.ts`, keyed by a stable `key`. This is
  where `mirrorField` and `singleton` live; they are not editable by orgs.
- **`documentTypes` table** holds only per-org overrides of a system type
  (by `key`) and per-org custom types.
- The **effective catalog** for an org is defaults merged with its rows,
  computed in a query. Changing a default in code updates every org.

| Field | Notes |
|---|---|
| `workosOrgId` | owner org |
| `key` | stable slug. Matches a system key for an override; unique custom slug otherwise |
| `name` | display name |
| `entity` | `driver` \| `carrier` \| `organization` (immutable once set) |
| `expires` | boolean. If false the row has an issue date only |
| `issueDateRequired` | boolean |
| `uploadRequired` | boolean. If false a dated entry without a file is allowed |
| `sharedByDefault` | `organization` entity only. See §6.2 |
| `sortOrder`, `hiddenAt` | system types can be hidden, never deleted |

Custom types can be deleted only when no `entityDocuments` row references
them; otherwise they can only be hidden.

Seeded system defaults:

- driver: CDL (mirror `licenseExpiration`, singleton), Medical certificate
  (mirror `medicalExpiration`, singleton), Badge (mirror `badgeExpiration`,
  singleton), TWIC (mirror `twicExpiration`, singleton), Drug screen (no
  expiry), I-9 (no expiry), Hazmat endorsement, Background check.
- carrier: Certificate of insurance (mirror `insuranceExpiration`,
  singleton), W-9, Operating authority, Owner-driver CDL (mirror
  `ownerDriverLicenseExpiration`, singleton), Carrier agreement.
- organization: Certificate of insurance, W-9, Operating authority, all
  `sharedByDefault`.

Operating authority as a document is the uploaded letter. It is separate
from the live FMCSA authority check on the partnership
(`authorityVerification`), which stays as is.

### Changing a type's flags after documents exist

| Change | Effect on existing active documents |
|---|---|
| `expires` false → true | Rows without an expiry show **Needs date** until edited |
| `expires` true → false | Expiry is ignored; status becomes **On file** |
| `uploadRequired` false → true | Rows without a file show **Missing** |
| `uploadRequired` true → false | Dated rows without a file become valid entries |
| hidden | Rows are kept but excluded from status and the missing summary |

Every flag change recomputes the missing summary (§3) for affected
entities in the same mutation, batched by entity type.

### `entityDocuments` — one table for all three entities

| Field | Notes |
|---|---|
| `workosOrgId` | owning org (who entered it) |
| `entity`, `entityId` | `driver`/driver id, `carrier`/partnership id, `organization`/org id. Referential integrity is enforced in mutations, not by the validator |
| `typeKey` | effective catalog key |
| `status` | `pending` \| `active` \| `archived` |
| `externalKey`, `fileName`, `contentType`, `sizeBytes` | null when `uploadRequired` is false and no file was attached |
| `issueDate`, `expirationDate` | `YYYY-MM-DD`, user-entered |
| `uploadedBy`, `uploadedAt` | |
| `archivedAt`, `archivedBy`, `archiveNote`, `supersededById` | |
| `shared` | `organization` entity only; overrides `sharedByDefault` |

Indexes: `by_entity` (`workosOrgId`, `entity`, `entityId`, `status`),
`by_type` (`workosOrgId`, `typeKey`, `status`), `by_status_uploadedAt`
(for the pending sweep).

Shared carrier documents are **not** copied into the broker's org. They are
read through a query that joins the linked carrier org's `organization`
documents (§6.2). Copying happens only via "Save a copy" (§7).

### Denormalized summary on the parent row

The drivers list and the carrier list must not read every document to
render a status column. Each parent row (`drivers`, `carrierPartnerships`)
gets `missingDocTypeKeys: string[]`, rewritten whenever a document is
activated or archived or a type flag changes. It is **time-independent**,
so it never drifts. Time-dependent states (expired, expiring) continue to
come from the mirror date fields, computed at read time with the caller's
`todayDateStr` exactly as today. Never denormalize a time-dependent status.

---

## 3. Status: one computation, every surface

Today the driver's document status is computed in four places from the
four date fields: the Documents tab, the Overview documents section
(`build-driver-details.tsx`), the driver page attention items (plus a
hard-coded `count: 4` and "4 documents on file"), and the drivers list
`needsAttention` count in `convex/drivers.ts`. The server helper
`getDateStatus` returns **valid** when no date exists, so a driver with no
medical date counts as fine today. The client tab duplicates the date
parsing with slightly different thresholds. Left alone, these four would
disagree with each other on day one.

Fix: a single module `convex/_helpers/documentStatus.ts`, plain TypeScript
importable by both Convex functions and the web app, exporting the status
function and the 30/60-day thresholds. Every surface above is rewritten to
use it and to read from `entityDocuments` plus the missing summary. The
existing duplicated date helpers in the tab and in `build-driver-details`
are deleted. `getDateStatus` is changed so an absent date is **missing**,
not valid; the drivers list attention count will rise on day one as a
result, which is the intended behavior.

Status per (entity, type):

| Situation | Status |
|---|---|
| No active row, never had one | **Missing** |
| No active row, previous row archived | **Missing**, with the archived row's expiry shown and its own expired/expiring state as a sub-label |
| Active row, `uploadRequired` and no file | **Missing** |
| Active row, type expires, no date | **Needs date** |
| Active row, type expires, date in the past | **Expired** |
| Active row, type expires, ≤ 30 days | **Expiring** |
| Active row, type expires, ≤ 60 days | **Warning** |
| Active row, type expires, > 60 days | **Valid** |
| Active row, type does not expire | **On file** |

The summary strip (On file / Valid / Expiring / Expired) gains **Missing**.
The Documents tab badge and the attention item counts become live.

---

## 4. Replacement and archive

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
- Placeholder buttons with no handler (the current Upload buttons on
  carriers and loads, the Export button on the archived card) are removed
  in the same change that wires the real ones. No dead buttons ship.

---

## 5. Driver rules

1. **Day one is Missing.** Existing drivers have dates but no files. They
   show Missing for every `uploadRequired` type until a file is uploaded.
   No transitional status. The CSV import and the create form still
   collect dates; the UI copy there says the date does not count as a
   document on file.
2. **Driver row dates are mirrors.** `licenseExpiration`,
   `medicalExpiration`, `badgeExpiration`, `twicExpiration` are written by
   the document workflow, not edited directly on the Documents tab. They
   keep the drivers list, the mobile APIs, and the partnership sync working
   without change.
3. **Archive without replacement keeps the stale mirror.** The driver row
   keeps its last known date; the Documents tab shows Missing with the
   archived expiry as context. If there was never a date, the mirror stays
   empty.
4. **`licenseExpiration` becomes optional in the schema.** Three code
   paths fabricate a license expiry today: `carrierMobile.ts` (one year
   out, twice) and `carrierPartnerships.ts` (`2030-12-31`, twice). All
   four stop. Since the field is currently required, that needs
   `v.optional(v.string())` plus a sweep of consumers (`drivers.ts`,
   `driverMobile.ts`, `dispatchMobile.ts`, `carrierPartnerships.ts`, the
   import mapping) to handle absence. The create form and import may keep
   requiring a date for now; that is a product choice, not a schema one.
5. **Mirror mapping** lives on the system document type (`mirrorField`).
6. Driver-app read access to driver documents is out of scope for phase 1.
   Before enabling it, `resolveAuthenticatedDriver` must scope by org: it
   currently returns the first driver matching the phone across all orgs.

---

## 6. Carrier rules

### 6.1 Ownership follows who entered it

- A broker's upload on a partnership is the broker's record. It lives under
  `orgs/{brokerOrgId}/carriers/{partnershipId}/` and is owned by the broker.
- A carrier org's upload of its own documents is the carrier's record. It
  lives under `orgs/{carrierOrgId}/company/` as an `organization` document.
  A broker's own compliance file uses the same entity kind under its own
  org.
- The same carrier partnered with several brokers may have a broker-owned
  copy per partnership. That is expected.

### 6.2 Linking shares top-down

- When a partnership has `carrierOrgId` set AND its status is `ACTIVE` or
  `SUSPENDED` (`partnershipSharesDocuments` in `convex/lib/orgLookup.ts`
  — an `INVITED`/`PENDING` link is not yet consented to, a `TERMINATED`
  one is over), the carrier org's `organization` documents whose type is
  `sharedByDefault` and whose `shared` flag is not false appear on the
  broker's partnership Documents tab as read-only rows with source
  **Carrier**. Only the system company types share — they are the ones
  with a `partnerTypeKey` counterpart on the broker side; a custom
  company type has no sharing toggle at all.
- The carrier controls sharing on its Settings › Documents page, per
  document. Defaults are shared for compliance types.
- Carrier updates propagate automatically; the broker sees the carrier's
  current active row.
- The broker can always add its own record alongside. The tab shows both
  sources.
- Unlinking or terminating the partnership removes the carrier-shared
  rows from the broker's view (every status change resummarizes the
  partnership). The broker's own records stay. Whatever the broker had
  relied on from the carrier reverts to the broker's own status
  immediately.

### 6.3 Effective status and mirrors

- Mirror fields are written from the effective document only. Once a
  document (own or carrier-shared) exists for the type, `drivers.update`
  and `carrierPartnerships.update` refuse a direct edit of that mirror
  (`assertMirrorsEditable`): replace the document instead. Rows with no
  document keep the field editable.
- `drivers.docExpirations` (typeKey → date) and `drivers.needsDateTypeKeys`
  are stamped with the summary so list-row attention covers expiring types
  that have no mirror field (hazmat, custom types) and "Needs date" rows;
  `countDriverAttention` reads them over the mirrors.
- `carrierPartnerships.ownerDriverLicenseExpiration` has one writer:
  `recomputePartnershipDocuments`, which picks the latest expiry among the
  broker's own `owner_driver_cdl` document, a carrier-shared one, and the
  linked owner-operator's own CDL document (`drivers.docExpirations.cdl`).

- For a type present from both sources, the effective status uses the
  **latest expiry** across the broker's active row and the carrier's shared
  active row. The row that won is marked as the source.
- `carrierPartnerships.insuranceExpiration` and
  `ownerDriverLicenseExpiration` are mirrors of the effective expiry,
  recomputed whenever either side's active row changes or the link
  changes. The existing one-way sync from the driver row to
  `ownerDriverLicenseExpiration` stays.

---

## 7. Offboarding, retention, purge

- `organizations` has soft-delete fields but no offboarding state. Add
  `offboardingStartedAt` and `purgeAt`. A platform action starts or
  cancels offboarding; `purgeAt = start + 14 days`. Data is retained in
  full during the window. Once `purgeAt` has passed the purge is
  committed and cancel is refused: the daily job deletes the bucket
  prefix first, and a cancel landing after that would keep rows whose
  bytes are gone.
- Every broker linked to an offboarding carrier org is notified and sees a
  **Save a copy** action on each carrier-shared row during the window
  only. Saving performs a server-side `CopyObject` into the broker's
  partnership prefix and creates a broker-owned `entityDocuments` row.
- Before purge the org can export its own prefix (per-org zip). Regulatory
  retention for driver qualification files outlives the platform
  relationship, so the export is offered explicitly in the offboarding
  flow rather than assumed.
- At `purgeAt` a cron (via `job()`) deletes the org's `orgs/{orgId}/`
  prefix and its `entityDocuments` and `loadDocuments` rows. This is the
  only automated physical deletion. Each org is purged independently: one
  org's storage error is logged and retried next run, never blocking the
  others. `convex/platform/support.ts` has no
  storage purge today; this adds one.

---

## 8. Access, permissions, audit

- **Permissions** use the existing slugs. Driver documents: `fleet:view`
  to list and preview, `fleet:edit` to upload, archive, or edit dates.
  Carrier partnership documents: the same slugs the carrier detail page
  already gates on. Organization documents and the Settings › Documents
  catalog: `settings:manage`. Sharing toggles: `settings:manage` on the
  carrier org.
- **One access function.** `canAccessDocument(ctx, doc, intent)` in
  `convex/entityDocuments.ts` is the only place the rule lives and is used
  by list queries, the signed-GET action, archive, and share changes. It
  covers: owner-org member with the required permission; a broker org
  member reading an `organization` document shared by a carrier org
  linked to one of the broker's partnerships; and, later, a driver reading
  their own. The current `getDocForAccess` for load documents checks org
  membership only, not permission; it is aligned to the same function.
- **Audit.** Every activate, archive, replace, date edit, and share change
  writes through `logAudit` on the **parent** entity (`driver`,
  `carrierPartnership`, `organization`) with new actions
  `document_uploaded`, `document_replaced`, `document_archived`,
  `document_dates_changed`, `document_share_changed`. The driver Activity
  tab already reads the parent's audit log, so document events appear
  there without extra UI. `AuditAction` and `AuditEntityType` are closed
  unions and are extended accordingly.

---

## 9. Cleanup that ships alongside

- Delete the unused `s3Upload.getUploadUrl` (client-chosen folder, outside
  the org prefix) and the deprecated `s3Upload.getPODUploadUrl`. Neither
  has a caller.
- Switch the load detail "has POD" check to `loadDocuments` only (it
  already reads both), then stop the `stop.deliveryPhotos` dual-write in
  `driverMobile.ts`. Migration 009 already backfilled history.
- Drop the `externalUrl` fallback from `loadDocuments.listForLoad`'s `url`
  field; consumers already fetch signed URLs on click.
- Remove the unused `loadCarrierDocuments` table.
- Add the storage env vars to `.env.local.example` with comments.
- Load detail's web Upload button uses the same presign/finalize helpers
  with entity `load`, replacing the unused Convex-storage `create` path.

---

## 10. Code shape

One small action per entity, sharing low-level helpers. No single generic
presign action: the per-entity argument shapes and access rules differ, and
the mobile client depends on the exact `getLoadDocumentUploadUrl` contract.

```
convex/lib/r2.ts                   key builders, metadata → headers, sanitize
convex/lib/documentTypeDefaults.ts system types (key, entity, flags, mirrorField, singleton)
convex/_helpers/documentStatus.ts  status function + thresholds, shared with the web app
convex/s3Upload.ts                 createS3Client, presignPut, presignGet, headObject, deleteObject, copyObject
convex/documentTypes.ts            effective catalog query, override/custom CRUD
convex/entityDocuments.ts          canAccessDocument, presign/finalize/archive/list, mirrors, missing summary
convex/driverDocuments.ts          thin driver-specific actions
convex/carrierDocuments.ts         thin partnership + organization actions, sharing join
```

Actions live in `'use node'` files and call `internal.*` functions with
explicit return type annotations. `s3Upload.ts` already documents the
generated-API type cycle this avoids; new files follow the same pattern.

---

## 11. Testing

`convex-test` and vitest are in place. Required before each phase merges:

- Unit tests for `documentStatus` covering every row of the §3 table,
  the stale-mirror case, and the threshold boundaries.
- Mutation tests for finalize (idempotency, singleton archive, mirror
  write, missing-summary rewrite), archive without replacement, and each
  type-flag transition in §2.
- Access tests: same org with and without permission, other org, broker
  reading shared vs unshared vs unlinked carrier documents, driver app.
- Extend `s3Upload.presign.test.ts` to pin the new key layout and signed
  metadata headers for each entity.
- Component tests for the driver tab: Missing rendering, upload form
  requiring the date, inline edit hidden for file-required types.

---

## 12. Phases

**After every deploy that introduces or extends a summary field** (this
branch adds `drivers.docExpirations` and `drivers.needsDateTypeKeys`), stamp
every row once — until then an unstamped driver counts as "every required
type missing" on list pages:

    npx convex run migrations/010_backfill_document_summaries:runAll

It schedules both self-chaining backfills; one command finishes the whole
table and is safe to re-run.

1. **Drivers.** §1 contract, system defaults + overrides table,
   `entityDocuments`, status module and the four-surface rewrite (§3),
   `licenseExpiration` optional and fabricated dates removed (§5.4),
   driver presign/finalize/archive, driver Documents tab wired (upload
   with date, archive, Missing, mirrors, live counts), Settings ›
   Documents page, audit actions, pending sweep cron, browser HEIC
   conversion, driver-app `prepareImageForUpload` hardening. CORS applied
   to the dev bucket first, then prod.
2. **Carriers.** Partnership documents, organization documents, sharing
   join, per-document share toggle, effective status, insurance and
   owner-driver mirrors, carrier Documents tab wired, missing summary on
   partnerships.
3. **Loads + cleanup.** Load detail web upload via shared helpers; §9.
   Built: `loadDocumentsWeb` presigns under the same load prefix as
   driver captures and HEAD-verifies before `loadDocuments.createFromWeb`
   records a key-only row. There is no pending row for loads (the table
   has no status column); a closed tab between PUT and finalize leaves an
   orphan object, same as the mobile flow. Dual-write to
   `stop.deliveryPhotos` ended; `listForLoad` no longer returns a public
   URL for R2 rows; `loadCarrierDocuments` was removed; delete on the
   load page requires loads:edit.
4. **Offboarding.** Org offboarding fields and platform action,
   notifications, Save a copy, export, 14-day purge job.
   Built: platform staff start/cancel offboarding from the admin console
   (`platform.support.startOffboarding` / `cancelOffboarding`, step-up
   auth, platform audit). Starting stamps `offboardingStartedAt` and
   `purgeAt = +14d` and writes an activity entry on every linked
   partnership; the broker's carrier page shows a rail notice and the
   Documents tab a banner with **Save a copy** on shared rows
   (`carrierDocuments.saveSharedCopy`: server-side CopyObject into the
   broker prefix, then the normal HEAD-verified activation). Export is an
   always-available **Export all documents** button on Settings › Company
   file (settings:manage) that zips every owned document plus a
   manifest.csv in the browser via signed GETs. The daily
   `offboardingPurge:purgeDueOrganizations` job deletes the org's
   `orgs/{orgId}/` prefix and its entityDocuments / documentTypes /
   loadDocuments rows in batches, then stamps `purgedAt` and soft-deletes
   the org.
