# Mobile Device Auth — Replace Clerk with device-bound credentials

> Status: **v0.6 draft, second adversarial pass** — captures the 2026-09-10 discussion end to end. Nothing here is built. v0.2 reworked the schema for reactivity (§23). v0.3 folded in four code audits (§24) and the decision that **there are no active drivers, so the cutover happens in one 24-hour window** (§14). v0.4 converted every open question into a decision (D23–D32). v0.5 fixed the refresh-grace design, a privilege-escalation path through the member sync, and a missing brute-force control (D33–D35). v0.6 (§25.4) caught that the `org_id` claim on driver tokens would have opened every org-scoped web function to drivers, and fixed it with D36–D38.
>
> Scope: **Otoqa Driver** and **Otoqa Dispatch** mobile apps, the web **Settings → Mobile access** page, and the platform console's mobile tooling. The web app and the staff console **stay on WorkOS**.
> Backend: the single shared Convex deployment (topology unchanged).

---

## 0. Summary

Today the mobile apps sign in through Clerk phone OTP (driver app, and owner-operators in the dispatch app) and an unfinished WorkOS PKCE scaffold (in-house dispatchers in the dispatch app). Every fresh token is a network round trip to a third party, and the driver app carries a large recovery state machine to survive that.

The plan: Otoqa becomes the token issuer for mobile. A device is **enrolled once** through a one-time enrollment token (delivered by SMS for drivers and carriers, or by QR code for members who are logged in on the web), receives a **device-bound credential**, and stays signed in until an admin revokes it. Convex validates the resulting JWTs through the same `customJwt` mechanism it already uses for WorkOS. Signing runs in the V8 runtime with Web Crypto, which `convex/fcmWake.ts` already proves works.

What we get: one-tap sign-in with no code entry, the structural removal of the failure class that generated ~245k token-fetch failures in July–August, deletion of the Clerk sync and recovery code, explicit admin control over devices, closure of two existing authorization holes on the location path, and no public sign-in surface at all. Convex cost is unchanged at any realistic scale.

What gates it externally: Twilio 10DLC registration (weeks) and a store-reviewed native build for Universal Links. The 24-hour cutover does not wait for either: QR, in-app QR scan, and typed codes work on day one; one-tap SMS links follow when those land.

---

## 1. Evidence (verified)

### 1.1 Current auth topology

| Surface | Provider | Notes |
|---|---|---|
| Web (`app/`, Next.js) | WorkOS AuthKit, Google Workspace SSO | Also the source of truth for org membership, invitations, roles, RBAC permission claims. ~25 SDK call sites. **Unchanged by this plan.** `app/api/**` has zero Clerk references. |
| Staff console (`apps/admin`) | Separate WorkOS project, authorized by issuer in `requirePlatformStaff` | **Unchanged.** |
| Driver app (`apps/driver`) | Clerk phone OTP (`@clerk/clerk-expo`), 10 files | `clerkSync.ts` creates Clerk users from driver records by phone; `userIdentityLinks` maps `clerkUserId` → org. |
| Dispatch app (`apps/dispatch`) | Clerk OTP for owner-operators (4 files); WorkOS PKCE scaffold for staff | The WorkOS token source is marked "device-validation pending — treat as scaffold". Never validated on a device. `lib/env.ts` hardcodes both the Clerk key and the WorkOS client id as fallbacks. |
| Convex | `convex/auth.config.ts` | Two WorkOS `customJwt` providers, one Clerk domain provider, one optional staff provider. Multiple providers coexist. |

### 1.2 The Clerk failure data (PostHog, `convex_auth_token_fetch_failed`)

| Window | Failures | Devices | Dominant error |
|---|---|---|---|
| July 2026 | 84,000 | 3 | `null_token_after_retry` |
| August 2026 | 161,000 | 5 | `null_token_after_retry` |
| Since ~Aug 23 | < 10 / day | 1–3 | mix of null token (background, iOS) and Clerk `signed_out` 401s |

- All on iOS, from 3–5 phones. The volume is a **retry loop**, not 245k distinct incidents. `apps/driver/lib/hooks/useConnectionRecovery.ts:34-38` documents the original 20s `setInterval` that produced "~20k auth cycles/day".
- Dropped to near zero around Aug 23. September residue carries the diagnostic properties.
- Root causes are structural to a remote token minter: Clerk unreachable while Convex is reachable; session not hydrated when a background task wakes; Clerk's own session lifecycle; keychain unreadable while locked (mitigated with `AFTER_FIRST_UNLOCK`).

### 1.3 Scale today (PostHog, last 30 days)

| Metric | Value |
|---|---|
| Unique mobile users | 9 (internal testers; **no active drivers** per product owner) |
| Daily active mobile users | 2–4 |
| Background task fires on an active day | ~1,500 (~400 per device per day) |
| Location sync cadence | batch every 30s while tracking (`SYNC_INTERVAL_MS`); heartbeat every 5 min |
| Live query subscriptions per open driver app | 7–9 (`getUserRoles`, `getMyProfile`, `getActiveSession`, 3× `featureFlags.getForOrg`, `getMyAssignedLoads`, `getSessionLoads`, `yardLocations.listForDriver`) |

### 1.4 How mobile actually authenticates today (audit facts that reshape the design)

- **Driver-app traffic does not go through `convex/lib/auth.ts`.** It goes through `driverMobile.resolveAuthenticatedDriver` (26 call sites: 14 mutations, 11 queries, 1 internalQuery) which resolves the driver from the **phone claim** (`phoneNumber ?? phone_number`) via `drivers.by_phone` × 3 variants, never reads `subject`, and does no org or employment-status check. Owner-mode traffic goes through `carrierMobile.requireCarrierAuth` (20 call sites) which is **fail-soft** (returns `null`, callers return `[]`), takes an untyped `ctx: { auth; db: any }`, and looks up `userIdentityLinks.by_clerk[subject]` with no role check.
- **`convex/lib/auth.ts` helpers are typed `AnyCtx = QueryCtx | MutationCtx | ActionCtx`** and touch no database. 22 action call sites depend on that (`vinDecoder`, `fuelReceiptImport`, `laneAnalyzerActions` ×4, `scheduleImport` ×3, `laneScheduleImport`, `samsaraVehicleMapping`, `externalTrackingWebhooks`, `externalTrackingPartnerKeys`, `accountingReports` ×3, `samsaraAdmin`, `platform/support`, `platform/stripe`). Blast radius of the three main helpers: ~664 references across ~100 files.
- **Six code paths decide "this is a driver" by the absence of an org claim**: `loadDocuments.getDocForAccess:206` (the true heuristic — "No org claim → driver-app caller"), `lib/auth.requireCapability:375-383`, `lib/auth.assertCallerInCarrierOrg:436-437`, `dispatchMobile.getSession:110-111`, `dispatchMobile.resolveOrgForRead:206-207`, `featureFlags.getForOrg:62-90`. `platform/tickets.reportProblem:35` uses null as "no org attribution".
- **`organizations.clerkOrgId` is never written anywhere.** Every carrier org created by the partnership flows has it undefined, and `org._id` is already doing duty as the carrier's external id. `userIdentityLinks` rows are created with a synthetic `clerkUserId: 'pending_<digits>'` until Clerk sync lands, so the OWNER path relies on the phone fallback for fresh carriers.
- **`dispatchMobile.resolveOrgForRead:216`** looks up `organizations.by_organization` keyed on `workosOrgId` and throws "Organization not provisioned for dispatch" if absent — carrier-only orgs would fail that path if their token carried `org_id` without a `kind` discriminator.
- **The location ingest path has two authorization holes today**: `/v1/mobile/locations` validates a static `EXPO_PUBLIC` key (shipped in the binary, compared with `!==`) and trusts client-supplied `driverId`, `sessionId`, `organizationId`; the foreground fallback `driverLocations.batchInsertLocations:805` checks identity presence only and then trusts `args.organizationId`. `s3Upload.getLoadDocumentUploadUrl:331` and `getPODUploadUrl:413` also check presence only.
- **Mobile token mirror is plaintext AsyncStorage**, not SecureStore (`auth-token-store.ts` → `storage.ts`). `getFreshToken()` is the single headless chokepoint (4 call sites: `location-tracking.ts:361,399`, `feature-flags.ts:121`, `yard-fences.ts:105`). The background-fetch task (`background-sync.ts`) is **inert headless**: `offline-queue.processMutation` needs a `mutationProcessor` injected from React, so nothing in that path can authenticate outside the tree.
- **`isPermitted` grants everything when `permissions == null`**, and `getCallerPermissionClaims` turns a malformed `permissions` claim into `undefined`, which also grants everything. Four paths grant with no permission check at all regardless of claims (`assertCallerInCarrierOrg` Path 1, `resolveOrgForRead` Clerk branch, `requireCapability` Clerk branch, `requireCarrierAuth`).
- **RS256 signing in V8 already exists**: `convex/fcmWake.ts:158-195` mints a JWT with `crypto.subtle` (PKCS#8 import + `RSASSA-PKCS1-v1_5`), ~150ms, no Node action. `jose` is not a dependency of anything Otoqa-owned.
- **Tests**: 47 files, 414 `withIdentity` call sites, five distinct identity shapes, no shared fixture, most with `as never` casts so a claim rename fails at runtime, not compile time.

### 1.5 Things that don't exist yet and this plan needs

- No SMS sending capability (Clerk sends the OTP today). No Twilio anywhere.
- No Universal Links / App Links. Only custom schemes `otoqa-driver` / `otoqa-dispatch`. No `Linking` URL listeners, no `getInitialURL`, no expo-router `linking` config anywhere; `expo-linking` is a dependency but never imported.
- No authoritative membership data in Convex and no WorkOS webhooks. `orgMembers` is a display-name directory synced best-effort on web login (`app/callback/route.ts` swallows errors, upsert-only, no delete, no status, 2000-row cap, skipped entirely when the session has no org claim); carrier-side roles live in `userIdentityLinks` keyed by Clerk user id.
- No cron touches auth today. No runbook exists for mobile sign-in failures.

---

## 2. Goals and non-goals

**Goals**
1. One tap to sign in after enrollment. No OTP entry, no waiting on SMS, no repeat sign-ins.
2. Remove the remote-token-minter failure class and the recovery machinery built around it.
3. Admin-controlled enrollment and revocation with a visible device list.
4. Background tasks can always read a valid credential, including while the device is locked.
5. No third party on the mobile critical path once a device is enrolled.
6. One implementation shared by both mobile apps (`packages/mobile-core`).
7. Close the two location-path authorization holes as part of the same change.

**Non-goals**
- Changing web or staff-console auth. WorkOS stays.
- Shared-device / per-shift PIN model. Trucks are shared; **mobile devices are not**.
- Building a general-purpose IdP.
- Consolidating the platform's three org identifiers (§23.4). Separate project.

---

## 3. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Mobile only. Web and staff console stay on WorkOS. | WorkOS does membership, invitations, roles, RBAC claims, SSO. |
| D2 | Both mobile apps move to the new system: Driver **and** Dispatch. | Dispatch's WorkOS flow was never device-validated. |
| D3 | Enrollment channels: **SMS (Twilio)** for drivers and carriers/owner-operators; **QR code** for org members logged in on the web. Carrier owners with web access also use QR. | Members already have an authenticated web session. |
| D4 | Both channels deliver the same one-time enrollment token to the same exchange endpoint. A **code-entry** screen accepts the same token typed by hand. | One exchange implementation; code entry doubles as the store-review path, the install-hop fallback, and the day-one path before Universal Links ship. |
| D5 | Long-lived device credential. No session timeout. Sign-out is deliberate and harder than today. | Threat model is lost/stolen device and terminated staff, handled by revocation. |
| D6 | Server-side revocation check on every authenticated **mobile** request (session id in JWT → `deviceSessions` primary-key read). WorkOS web tokens skip it. | Makes token lifetime irrelevant to security. |
| D7 | Access token lifetime **12 hours**; refresh token rotated on use with a **replay grace window**. | 24× fewer refreshes than 1h; grace prevents the rotation lockout race. |
| D8 | Local token cache; only call the server near expiry or on a rejected token. Never trust the device clock alone. | Convex re-asks for a token on every websocket reconnect. |
| D9 | Mobile access management lives on a **dedicated Settings page**. The driver profile's "Mobile app access" card becomes a read-only summary linking there. | Product owner decision. |
| ~~D10~~ | ~~Silent Clerk migration.~~ **Superseded (v0.3):** no active drivers → direct cutover in one window, no dual providers, no flag, no `legacy/clerk` folder. Internal testers re-enroll. | Product owner, 2026-09-10. |
| D11 | Identity is the **driver record / member identity**, not the phone number. `sub` = `drivers._id` or WorkOS user id. | Phone changes and shared numbers must not move access. |
| D12 | Authorize mobile **member** requests from `orgMemberships` rows once the mirror is authoritative; until then, refresh-time WorkOS membership check with bounded grace. | See OQ-1. |
| D13 | Clerk sign-in tokens rejected as the destination. | Keeps every reliability problem. |
| ~~D14~~ | ~~Convex Auth spike.~~ **Superseded by D33 (v0.5): hand-rolled, no spike.** | |
| D15 | Optional biometric gate on owner-mode pay screens. | Answers "no MFA?" on questionnaires; ~1 day. |
| D16 *(v0.3)* | **The `kind` claim is the only discriminator between driver and member callers.** Org-claim presence is never used as a signal again. | Six existing branches use absence-of-org-claim as "driver"; the new token carries `org_id` for everyone. |
| D17 *(v0.3)* | **Revocation lives in the mobile caller helper, which is where mobile traffic actually flows** (`resolveCaller`, replacing `resolveAuthenticatedDriver` and `requireCarrierAuth`). The `lib/auth.ts` helpers stay database-free for WorkOS tokens and delegate to `resolveCaller` only when the token's issuer is ours. In action contexts the check goes through `ctx.runQuery`. | `AnyCtx` typing on 22 action call sites; driver traffic bypasses `lib/auth.ts` today. |
| D18 *(v0.3)* | **New `orgMemberships` table** is the single authoritative membership table. `userIdentityLinks` and `orgMembers` are both retired into it. | `orgMembers` is keyed on a WorkOS string, has no role/status/delete, and carrier-only orgs can't have rows; evolving it would carry a fragile seam forward. |
| D19 *(v0.3)* | **No new RBAC area.** Driver devices are gated by `fleet:manage`, member devices by `team:manage`. | The role seeder never back-fills permissions into existing populated roles; a new area would be silently ungated for legacy tenants and absent from every preset. |
| D20 *(v0.3)* | **Signing: RS256 in the V8 runtime with Web Crypto**, following `fcmWake.ts`. No Node action, no `jose`. JWKS served as a static file. | Proven in-repo; resolves OQ-8/OQ-9. |
| D21 *(v0.3)* | **One shared identity test fixture** (`convex/_helpers/testIdentity.ts`) and all 47 test files migrate to it in the same window. | 414 inline fixtures with `as never` casts. |
| D22 *(v0.3)* | **Both location ingest holes close in this change**: `/v1/mobile/locations` on bearer JWT, and `driverLocations.batchInsertLocations` deleted (the HTTP route becomes the only ingest path). | They are the same bug class the security review flagged; the credential makes the fix natural. |
| D23 *(v0.4, was OQ-1)* | **Member freshness at launch = refresh-time WorkOS check.** On every refresh of a `source: 'workos'` member, call `listOrganizationMemberships` for that user; membership gone or inactive → revoke with `member_removed`; role/permissions re-copied into the new token and into `orgMemberships`. WorkOS unreachable → reissue on last-known claims for at most 48h, then refuse. Login sync stays upsert-only. WorkOS webhooks (W11) trail and make the table authoritative; `resolveCaller` then reads role/permissions from the row instead of the claims, one flag flip. | One call per device per 12h on an endpoint already used in ~20 places; no new infrastructure on the cutover day; bounded staleness stated. |
| D24 *(v0.4, was OQ-2)* | **One credential per person + org.** `sub` is the member identity; the token carries explicit `driverId` and `membershipId` claims, and `kind` lists both roles. Enrollment resolves the person by phone/email match across `drivers` and `orgMemberships` within the org and links both. | Keeps audit attribution on the member id (display names resolve by WorkOS user id), while driver-gated code checks `driverId`. Owner mode is leaving the driver app anyway. |
| D25 *(v0.4, was OQ-3)* | **A driver on two carriers is two principals.** `drivers.organizationId` is a single string: each carrier already has its own driver row, so each row is its own `sub` and enrolls its own device credential. No org picker. | Matches the data model that exists; nothing to build. |
| D26 *(v0.4, was OQ-4)* | **Link senders**: any web user with `fleet:manage` for drivers and `team:manage` for members (D19); platform support with a required reason and `logPlatformAudit`. Dispatch-app users cannot send links. | Mirrors who can already edit those records. |
| D27 *(v0.4, was OQ-5)* | **Self-service enrollment is built and shipped off.** Org setting in `featureFlags` (`mobile_self_enroll`, default `false`). When on: the driver types a phone number; the server always answers "if this number is on file, you'll get a text" (no enumeration), sends only when it matches an active, non-deleted driver in an org with the flag on, 3 per phone per hour. | Removes the admin support desk at fleet scale; no exposure for orgs that don't opt in. |
| D28 *(v0.4, was OQ-6)* | **One active device per principal.** A new enrollment revokes the previous session with `device_replaced` and notifies the admin (settings page + audit). Org setting `mobile_max_devices` (default 1) raises it. | Shared phones are not a use case; one device is the safest default and the simplest UI. |
| D29 *(v0.4, was OQ-7)* | **Phones stored as E.164; Twilio US-only at launch.** `normalizePhoneToE164` moves out of `clerkSync.ts` into `_helpers/phone.ts`; a one-off query on cutover day reports any non-`+1` numbers; Mexico/Canada senders are added when one appears. | The normalizer already assumes US; don't register foreign senders for zero drivers. |
| D30 *(v0.4, was OQ-10)* | **TTLs: SMS token 15 min, QR token 2 min, typed code same as its token.** A resend invalidates the outstanding token. | Codes are shoulder-surfable; SMS delivery can lag. |
| D31 *(v0.4, was OQ-11)* | **Dormant after 90 days without a refresh.** Marked by the daily sweep; a later refresh is rejected and the device re-enrolls. | Long enough for seasonal drivers, short enough that a forgotten phone doesn't hold a live credential for a year. |
| D32 *(v0.4, was OQ-14)* | **Historical Clerk subjects stay as they are.** Fix `payProfiles.resolveActorName` so a non-`user_` id renders "Unknown user", not "System". | No real users; rewriting audit history is worse than a few unresolvable names. |
| D33 *(v0.5)* | **Hand-rolled issuer; the Convex Auth spike (D14) is dropped.** Revisit only if Convex Auth leaves beta and supports custom claims, per-request revocation, and headless token access without wrapping. | Every downstream piece (claim shape, `resolveCaller`, ingest auth, settings page) depends on the token design. Keeping a fork open would have meant designing twice; Convex Auth's magic-link and rotation are the two parts that are cheapest to write ourselves, and its beta status was already the stated risk. |
| D34 *(v0.5)* | **Membership rows for WorkOS-backed orgs are written only by a Convex Node action that fetches from WorkOS with a server API key.** No public mutation accepts membership data from a client. | `orgMembers.syncMembers` is public and trusts its payload today; with `role`/`permissions` on the row and the row authorizing mobile requests, that would be a privilege escalation. |
| D35 *(v0.5)* | **Refresh-token reuse detection revokes the session.** A superseded token presented outside the grace window, or an invalidated successor, ends the whole family. | Standard rotation security; also fixes the v0.4 grace design, which assumed the server could re-return a token it never stored. |
| D36 *(v0.6)* | **A driver token is never an org member.** The shared org-member helpers (`requireCallerOrgId`, `requireCallerIdentity`, `assertCallerOwnsOrg`, `assertOrgPermission`) throw for `kind: ['driver']` tokens from our issuer; `getCallerOrgId` returns null for them. Driver access is granted only by explicit `resolveCaller({ allow: ['driver'] })` calls. | Without this, giving drivers an `org_id` claim (D16) would have opened every org-scoped web function — loads, customers, driver PII — to any enrolled driver. Preserves today's behavior, where a driver token fails those helpers for lack of an org claim. |
| D37 *(v0.6)* | **Carrier roles are mapped to permission slugs at mint time** (`permissionsForCarrierRole`: OWNER/ADMIN → all capabilities, MEMBER → dispatcher preset). | `isPermitted` only understands the `admin` slug and a `permissions` array; carrier `OWNER` tokens would otherwise be denied every dispatch capability. |
| D38 *(v0.6)* | **Refresh rotation is one atomic mutation**; the action only generates randomness before and signs after. Grace applies to any token in the family within 60s of the last rotation. | Two concurrent headless refreshes (separate JS contexts on Android) must not produce a false reuse revocation. |

---

## 4. Open questions — all resolved (v0.4)

Every question is now a decision in §3. Kept here as the index of what was asked and where it landed.

| # | Question | Resolution |
|---|---|---|
| OQ-1 | Membership freshness for members | **D23** — refresh-time WorkOS check with 48h grace at launch; webhooks (W11) make `orgMemberships` authoritative afterwards. |
| OQ-2 | One person, two roles | **D24** — one credential per person + org; `sub` = member identity; explicit `driverId` + `membershipId` claims. |
| OQ-3 | Drivers on more than one carrier | **D25** — each carrier's driver row is its own principal (verified: `drivers.organizationId` is single-valued). |
| OQ-4 | Who may send SMS links | **D26** — `fleet:manage` / `team:manage` on the web; platform support with reason. |
| OQ-5 | Self-service enrollment | **D27** — built, off by default per org, non-enumerating, 3/phone/hour. |
| OQ-6 | Devices per principal | **D28** — one; new enrollment replaces the old; `mobile_max_devices` org setting. |
| OQ-7 | Cross-border numbers | **D29** — E.164 storage, US-only Twilio sender at launch, cutover-day check for non-`+1`. |
| OQ-8 | Signing runtime | **D20** — V8 + Web Crypto, RS256. |
| OQ-9 | JWKS hosting | **D20** — static file. |
| OQ-10 | Token TTLs | **D30** — SMS 15 min, QR 2 min. |
| OQ-11 | Dormancy window | **D31** — 90 days. |
| OQ-12 | Carrier-only org identifier | **Audit** — `clerkOrgId` is never written; `org_id` = `workosOrgId` else `organizations._id`; `by_clerk_org` dropped (`lib/orgLookup.ts:21-25`, ~35 `carrierPartnerships.ts` sites). |
| OQ-13 | Location ingest static key | **D22** — in scope. |
| OQ-14 | Historical Clerk subjects | **D32** — leave; fix `resolveActorName`. |

Anything new goes in a fresh row here and a fresh D-number in §3.

---

## 5. Identity and data model

### 5.1 Principals

| Kind | Who | Enrollment channel | `sub` |
|---|---|---|---|
| `driver` | Company drivers, carrier drivers | SMS (code on day one) | `drivers._id` |
| `member` | In-house dispatchers, org admins, carrier owners/admins | QR (self-enroll from web session); SMS for carrier owners without web access | WorkOS user id (WorkOS-backed orgs) or `orgMemberships._id` (carrier-only orgs) |

No "principals" table. Never the phone number, never the Clerk user id. A person who is both (D24) is a **member** principal whose token also carries `driverId`; a person driving for two carriers (D25) is two driver principals with two credentials.

### 5.2 Design rules for the new tables

1. **The document read on every authenticated mobile request is written only on create and revoke.** Convex subscribes every query to every doc it reads; ~7–9 live subscriptions per open driver app would all depend on it. `driverSessions` was designed "lean" on the same premise and then acquired a 15-second `lastPingAt` write (`driverLocations.ts:661-669`); don't repeat that.
2. **`sid` is the session document's Convex id.** `ctx.db.get(normalizeId(...))`, one primary-key read, fail closed on garbage.
3. **Nothing auth-related is added to `drivers`.** Its four Clerk fields come off.
4. **No duplicate of existing state.** Push tokens stay on `driverSessions` / `driverPushTokens` / `dispatchPushTokens`.
5. **Org references follow the existing convention.** New tables carry both `organizationId: v.id('organizations')` and `orgKey: string` (the token's `org_id`).
6. **Small tables, narrow indexes, one purpose each.**
7. **Every field drop is a numbered migration** (`convex/migrations/NNN_*.ts`, next free number 019; follow `007_strip_parsed_columns.ts`: paginated batch, `patch({ field: undefined })` guarded by `!== undefined`, `internalAction` driver, run before the schema push). `userIdentityLinks.clerkUserId` is **non-optional**, so that table is dropped whole after backfill rather than stripped. **A table can only leave the schema once it is empty**: the drop migrations for `userIdentityLinks` and `orgMembers` delete every row (paginated) after the backfill is verified, and only then does the schema push remove the table.
8. **`orgMemberships` rows are write-rarely too.** After W11 the mobile helper reads the caller's membership row on every request (primary key via `deviceSessions.membershipId`), so every open dispatch app subscribes to it. The sync must patch **only when a field actually changed** (the current `syncMembers` already does this for names); there is no `syncedAt` bump on an unchanged row, and nothing like `lastSeenAt` ever lives on it. Sync bookkeeping goes on a separate `orgMembershipSyncs` row per org.

### 5.3 New tables (Convex)

```
devices                                  // one row per enrolled install
  principalKind: 'driver' | 'member'
  driverId?: Id<'drivers'>
  workosUserId?: string
  membershipId?: Id<'orgMemberships'>
  organizationId: Id<'organizations'>
  orgKey: string
  platform: 'ios' | 'android'
  deviceName: string
  appId: 'driver' | 'dispatch'
  appVersion, osVersion
  installId: string
  enrolledAt, enrolledVia: 'sms' | 'qr' | 'code'
  lastSeenAt?: number                     // throttled client heartbeat, ≤ once/hour; never from the auth helper
  status: 'active' | 'revoked' | 'dormant'
  revokedAt?, revokedBy?, revokedReason?
  .index('by_driver', ['driverId'])
  .index('by_workos_user', ['workosUserId'])
  .index('by_orgkey_status', ['orgKey', 'status'])
  .index('by_status_lastseen', ['status', 'lastSeenAt'])

deviceSessions                           // THE doc the mobile helper reads. Written ONLY on create and revoke.
  deviceId: Id<'devices'>
  principalKind, driverId?, workosUserId?, membershipId?, organizationId, orgKey   // denormalized: helper needs no second read
  status: 'active' | 'revoked'
  revokedAt?, revokedReason?: 'admin' | 'sign_out' | 'driver_deactivated' | 'member_removed' | 'device_replaced' | 'dormant' | 'token_reuse'
  .index('by_device', ['deviceId'])

deviceRefreshTokens                      // rotation state; read only by the refresh action
  sessionId: Id<'deviceSessions'>
  tokenHash: string                       // sha-256 via Web Crypto, raw never stored (pattern: externalTrackingAuth)
  status: 'active' | 'superseded' | 'invalidated'   // invalidated = successor of a replayed-in-grace token; never usable
  supersededAt?, successorId?: Id<'deviceRefreshTokens'>
  usedAt?                                 // set when this token is presented; a successor with usedAt set cannot be invalidated by grace replay
  expiresAt                               // rotation time + 90 days (D31) — expiry IS the dormancy mechanism
  .index('by_hash', ['tokenHash'])
  .index('by_session', ['sessionId'])
  .index('by_status_expires', ['status', 'expiresAt'])

enrollmentTokens                         // single-use
  tokenHash: string
  codeHash: string                        // the short typable form, separately hashed
  principalKind, driverId?, workosUserId?, membershipId?, organizationId, orgKey
  channel: 'sms' | 'qr' | 'code'
  createdBy: string
  expiresAt
  usedAt?, usedByDeviceId?
  deliveryStatus?: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'opted_out'
  twilioMessageSid?
  .index('by_hash', ['tokenHash'])
  .index('by_code_hash', ['codeHash'])
  .index('by_orgkey_expires', ['orgKey', 'expiresAt'])
  .index('by_expires', ['expiresAt'])

orgMemberships                           // D18: the ONE membership table, both org kinds
  organizationId: Id<'organizations'>
  orgKey: string
  principalKind: 'member'
  workosUserId?: string                   // WorkOS-backed orgs
  driverId?: Id<'drivers'>                // owner-operators who also drive (D24)
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | string   // carrier roles today; WorkOS role slug for WorkOS orgs
  permissions?: string[]
  status: 'active' | 'inactive'
  source: 'workos' | 'local'
  firstName?, lastName?, email?, phone?   // display snapshot (replaces orgMembers)
  createdAt, updatedAt                    // updatedAt moves only when a field changed (rule 8)
  .index('by_orgkey_user', ['orgKey', 'workosUserId'])   // replaces orgMembers.by_org_user
  .index('by_orgkey_status', ['orgKey', 'status'])
  .index('by_driver', ['driverId'])
  .index('by_workos_user', ['workosUserId'])
```

### 5.4 Existing tables

- **`orgMemberships` replaces both `orgMembers` and `userIdentityLinks`.** `orgMembers` readers (8 sites, mostly through `getMemberDisplayMap` in `convex/orgMembers.ts:77`) repoint to `orgMemberships` by `orgKey` + `workosUserId`. `userIdentityLinks` (50 non-test references; 12 in `carrierPartnerships.ts` including a full-table `.collect()` at `:2350`) backfills into `orgMemberships` with `source: 'local'`, then the table is emptied and dropped.
- **The WorkOS-side rows are written only by Convex itself (v0.5, D34).** Today `orgMembers.syncMembers` is a **public mutation that trusts a client-supplied member array** (`convex/orgMembers.ts:23-40`; the comment there admits it and relies on the payload being display-only). Once the table carries `role`/`permissions` and authorizes mobile requests, any authenticated web member could call it directly and write themselves `admin`. So: `syncMembers` becomes an `internalMutation`; a Convex action `orgMemberships.syncFromWorkOS` (V8 runtime — `fetch` is available there, no `'use node'` and no SDK needed) calls the WorkOS REST API for `listOrganizationMemberships` (role slug per member) and the org's roles → permissions map (`listOrganizationRoles` / environment roles) using a new `WORKOS_API_KEY` env var on the deployment, then writes through the internal mutation. The web login callback and the "resolve names" client hook call a public action `orgMemberships.requestSync` that takes **no data**, derives the org from the caller's identity, and schedules the Node action. `lib/sync-org-members.ts` and `app/api/organization/members/sync/route.ts` shrink to that trigger. The same Node action serves D23's refresh-time check.
- **`organizations`**: drop `clerkOrgId` and index `by_clerk_org`; update `orgType` comments.
- **`drivers`**: drop `clerkUserId`, `clerkSyncStatus`, `clerkSyncError`, `clerkSyncedAt` via strip migration.
- **`orgHealthSnapshots.identityLinkCount`** → `membershipCount`.
- **`platform/support.recordActionAudit`** action union (single literal `'clerk_resync_triggered'`) → replace with the new device actions.
- Push tables unchanged.

---

## 6. Token design

### 6.1 Claims

```
iss:  https://<otoqa-issuer>              (≠ every WorkOS issuer; ≠ STAFF_ISSUER)
aud:  convex
sub:  drivers._id | WorkOS user id | orgMemberships._id
sid:  deviceSessions._id
kind: ["driver"] | ["member"] | ["driver","member"]      // D16: the ONLY discriminator
org_id: workosOrgId | organizations._id                   // present on EVERY token
organizationId: Convex org id
name, email
phone                                     // as `phone_number` for the transition; removed once resolveAuthenticatedDriver is gone
role, permissions[]                       // ALWAYS present on member tokens; drivers get permissions: []
app: "driver" | "dispatch"
iat, exp (12h), nbf
```

### 6.2 Signing and validation (D20)

- RS256 with Web Crypto in the V8 runtime, following `convex/fcmWake.ts:158-195` (PKCS#8 import, `RSASSA-PKCS1-v1_5`, `crypto.subtle.sign`). Private key PEM in a Convex env var; `kid` in the header.
- JWKS as a static file on the **production** web domain (`/.well-known/jwks.json`), which must be publicly fetchable by Convex: not a preview URL, not behind Vercel deployment protection, no auth. Rotation: add new key to JWKS → sign with it → keep old key ≥ 13h → remove. Convex caches JWKS, so a rotation is announced to Convex by the `kid` on the next token.
- `convex/auth.config.ts`: one `customJwt` provider `{ issuer, algorithm: 'RS256', jwks, applicationID: 'convex' }`. The Clerk provider block is removed in the same deploy.

### 6.3 Refresh flow

1. Client holds `accessToken` (memory + SecureStore) and `refreshToken` (SecureStore).
2. Token callback returns the cached access token unless within N minutes of `exp` or `forceRefreshToken` is set and the last refresh was more than a few seconds ago.
3. `refresh` action: generate the candidate successor (random bytes + hash) **in the action**, then call **one mutation** `rotateRefreshToken({ presentedHash, successorHash })` that reads state and decides atomically (Convex mutations are serializable; two racing refreshes serialize rather than both rotating). The mutation returns one of:
   - `rotated` — presented token was `active`: insert successor, mark old `superseded` (`supersededAt`, `successorId`).
   - `rotated` via grace — presented token was `superseded` or `invalidated` **within `GRACE_MS` (60s) of its family's last rotation**, and no successor in that window has been *used* (`usedAt` unset): mark every unused successor in the window `invalidated`, insert the new successor. This covers both a lost response and two headless tasks refreshing at once (iOS and Android background tasks can run in a separate JS context, so a client-side single-flight is not enough).
   - `reuse` — presented token was superseded or invalidated **outside** the grace window, or is expired: revoke the session (`revokedReason: 'token_reuse'`), audit, return `session_revoked`. A token that should no longer exist means a replay or a cloned credential; kill the family.
   The action signs the access token (Web Crypto) only after `rotated`. Session status is read inside the same mutation (`status !== 'active'` → `session_revoked`).
   (v0.5 fix: v0.4 said "return the successor pair again", which is impossible — raw tokens are never stored. v0.6 fix: v0.5 read, decided, and wrote in separate steps, so two concurrent refreshes could both rotate and one would then be flagged as reuse.)
4. New successors get `expiresAt = now + 90 days` (D31). Every presented token gets `usedAt` set. **Nothing on `deviceSessions` is written** except by a reuse revocation.
5. Members: re-read role/permissions per D23; membership gone → revoke, `member_removed`.
6. Response codes: `ok`, `session_revoked`, `member_removed`, `device_dormant`; client-side `server_unreachable`.

### 6.4 Storage on device (audit-corrected)

| Item | Where | Accessibility |
|---|---|---|
| Refresh token | `expo-secure-store` | `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` |
| Access token | memory + `expo-secure-store` | `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` — readable from `TaskManager` tasks on a locked phone |
| Install id | MMKV plaintext instance | regenerated on reinstall |

- **Never AsyncStorage.** Today's JWT mirror (`auth-token-store.ts` → `storage.ts`) is plaintext AsyncStorage; that file is deleted.
- **Keep the access token under 2 KB.** `expo-secure-store` warns above 2,048 bytes on iOS and larger values are unreliable. An RS256 JWT with name, email, and a 24-slug `permissions` array is roughly 1.3–1.5 KB. The issuer asserts the size at mint time; if it ever grows (more permission slugs), `permissions` is replaced by `role` + a permissions version and the helper reads permissions from `orgMemberships` (which W11 does anyway).
- **Not the location-queue MMKV instance**: its AES key sits in SecureStore under the default `WHEN_UNLOCKED`, so it is unreadable from a locked-phone background task. Separate concern; leave it.
- The dispatch app's SecureStore writes carry no `keychainAccessible` option today; the shared client sets it on both apps.
- iOS keychain survives app deletion; Android Keystore doesn't. Re-enrollment after reinstall is a first-class path.

### 6.5 Revocation (D6, D17)

- `resolveCaller(ctx)` in `convex/lib/mobileAuth.ts` is the **only** mobile auth entry point. It reads `sid`, `normalizeId('deviceSessions', sid)`, `ctx.db.get` (or `ctx.runQuery(internal.deviceAuth.sessionStatus)` when `'db' in ctx` is false), fails closed on `status !== 'active'`, and returns `{ kind, subject, driverId?, membershipId?, workosUserId?, orgKey, organizationId, sessionId, name, email, role?, permissions? }`.
- The `lib/auth.ts` helpers (`requireCallerOrgId`, `requireCallerIdentity`, `assertCallerOwnsOrg`, `assertOrgPermission`, `getCallerOrgId`) check `identity.issuer`: WorkOS/staff → unchanged, no database; ours → delegate to `resolveCaller` (the runtime ctx branch keeps the `AnyCtx` signature intact for the 22 action call sites).
- **Those helpers mean "org member", and a driver is never an org member (D36, v0.6).** Today a driver token has no org claim, so every one of the ~530 web-oriented functions behind `requireCallerOrgId` / `assertCallerOwnsOrg` rejects it. The new token carries `org_id` for drivers too; if the helpers accepted it, any driver could call `loads.list`, customer queries, or driver-PII reads scoped to their own org. So for our issuer the helpers require `kind ∋ member` and throw `NotOrgMember` for driver-only tokens; `getCallerOrgId` returns `null` for them, preserving `entityDocuments.canAccessDocument`'s deny. Driver access is only ever granted by functions that call `resolveCaller({ allow: ['driver'] })` explicitly (the 26 former `resolveAuthenticatedDriver` sites, the location ingest, the driver document path). Dual-role tokens (D24) pass the member helpers as members.
- Org document lookups for our tokens use the `organizationId` claim (`ctx.db.get`), never `organizations.by_organization[workosOrgId]`, so carrier-only orgs resolve without a WorkOS id.
- Triggers: admin revoke; driver deactivate/delete → revoke all (replaces `scheduleDeleteClerkUser`); member deactivate/delete in the web team routes → revoke via `ConvexHttpClient` with the caller's WorkOS token (same mechanism `lib/sync-org-members.ts` already uses); one-device policy (D28); explicit sign-out; dormancy sweep.

---

## 7. Enrollment

### 7.1 Common exchange

`POST /enroll` (HTTP action): `{ token | code, platform, deviceName, installId, appId, appVersion, osVersion }` → verify by `tokenHash` or `codeHash` (Web Crypto SHA-256 in V8, per `http.ts:49-55`), not used, not expired → create `devices` + `deviceSessions` + first `deviceRefreshTokens` → mark used → return `{ accessToken, refreshToken, principal }`. Single use, bound to the first redeemer.

Abuse controls (v0.5): Convex exposes no client IP (`http.ts:102-109`), so per-IP limiting is impossible and the typed code is the brute-force surface. Controls, all through named limits on the existing `RateLimiter` instance, consumed via an `internalMutation` like `consumeRateLimit`:
- **Global failed-enrollment bucket**: 60 failures/min platform-wide. When it trips, every `/enroll` returns 429 for the window and a platform alert fires (`platform/alerts`). An 8-character base32 code is 40 bits; at 60 guesses/min against a 15-minute token the success probability is ~1e-9, and the alert makes any attempt visible.
- **Per-`installId` bucket**: 10 failures/min. `installId` is client-supplied, so this only throttles a naive client, but it keeps one misbehaving device from consuming the global bucket. (v0.6: the v0.5 "burn a code after 5 attempts" was meaningless — a wrong guess matches no code, so there is nothing to attribute it to.)
- **Uniform responses**: invalid, expired, and used all return the same 400 body and similar latency; nothing distinguishes "no such code" from "expired code".
- Refresh gets its own bucket keyed by the session id resolved from the presented token (10/min) so a misbehaving client can't hammer rotation.

### 7.2 SMS (drivers, carriers)

- Twilio. Body: `<Org>: your Otoqa Driver code is <CODE>. Open the app and enter it, or tap <https://<short-domain>/e/<token>>`.
- **Day one**: the code is the working path (no Universal Links until the store build lands, §13). The https link works once associated domains ship; until then the landing page shows the code and a store badge.
- TTL 15 min. One outstanding token per driver. Delivery status via Twilio status callback → `deliveryStatus`. STOP/HELP → `opted_out`, shown on the settings page.
- Prerequisites with lead time: 10DLC brand + campaign; own short domain; templates (EN/ES); international (D29).

### 7.3 QR (members)

- Settings page → "Add this phone": token minted **for the current user only**, TTL 2 min, rendered as a QR encoding the https link **and** shown as a code.
- Day one: the app's "Scan QR" button (`expo-camera` is already in the driver app; add to dispatch) reads the token directly, so the camera-app Universal Link path is not required.
- Convex reactivity shows the device appear live with a "This wasn't me — revoke" button.
- The mint mutation runs under the member's WorkOS identity and stores only `membershipId` on the enrollment token. At exchange time the issuer reads role/permissions from the `orgMemberships` row (fresh: `requestSync` ran at this login), so no claims are ever copied into `enrollmentTokens`.

### 7.4 Code entry

- 8 characters, base32 without ambiguous glyphs, separately hashed. Used for: day-one SMS, the install hop, App Review, Android unverified App Links.

### 7.5 Dev / staging

- Flag `mobileAuth.sendSms` off → link and code printed to the Convex log and shown on the settings page. Per-environment link domains.

---

## 8. Lifecycle and recovery flows

| Situation | Behavior |
|---|---|
| Normal use | cached access token; refresh ~every 12h while alive; background tasks read SecureStore directly |
| Offline for days | expired access token must **not** block local features; refresh on reconnect; only a rejected refresh changes auth state |
| Reinstall on iOS | keychain still holds the refresh token → silent resume |
| Reinstall on Android / new device | "Contact your admin" screen with admin name + one-tap request (push/email to dispatcher) + code entry; self-service if D27 on |
| Device transfer | not automatic; new device enrolls, old revoked per D28 |
| Admin revoke / driver deactivated | next request `SessionRevoked` → app clears local state → "Access removed" |
| Member removed on the web | team route revokes directly (§6.5); refresh catches anything missed (D23) |
| Sign out | confirmation → `performSignOut` sequence (push token, ping queue, motion service, yard fences) → server revoke. Dispatch gets the same `logout.ts` (it has none today) |
| Dormant | the active refresh token carries `expiresAt = rotation + 90 days` (D31); a refresh after that is rejected as expired → re-enroll. The daily sweep marks `devices.status = 'dormant'` for rows whose only active refresh token has expired, purely so the settings page shows the truth; security does not depend on the sweep. |
| Cleanup cron | daily; template `driverSessions.sweepStaleSessionsForAutoTimeout` (`.take(batch)` + self-reschedule) and `entityDocuments:sweepPending` (created-but-never-finalized). Deletes used/expired `enrollmentTokens`, `superseded` refresh tokens past grace, marks dormant devices. Housekeeping only. |

---

## 9. Authorization changes (in the same window, before the new issuer is live)

1. **Legacy permission rule.** `isPermitted`: `permissions == null` grants everything; malformed claims collapse to `undefined` and also grant everything. Change: legacy grandfathering applies **only** to WorkOS-issuer tokens; our issuer always emits `permissions` (empty for drivers); a malformed claim denies. Callers: `lib/auth.ts:234`, `dispatchMobile.ts:120,211`, `lib/use-permissions.ts:18`, `lib/team-server.ts:68`.
2. **Retire the org-claim heuristic (D16).** Rewrite the six branches in §1.4 to switch on `kind`. `loadDocuments.getDocForAccess` gets an explicit driver branch keyed on `kind` including `driver`; `resolveOrgForRead` keys on `kind` before looking up `by_organization`; `platform/tickets.reportProblem` attributes org from `orgKey`.
3. **Replace `resolveAuthenticatedDriver`** (26 sites) with `resolveCaller` requiring `kind ∋ driver`; drop the phone lookup and the `claimedDriverId` tautology; add the `employmentStatus === 'Active'` and `!isDeleted` checks it lacks today.
4. **Replace `requireCarrierAuth`** (20 sites) with `resolveCaller` requiring `kind ∋ member` and a role check; make it **fail-loud** (today it returns `null` and screens go blank).
5. **Collapse `getUserRoles`** (Methods 1/2/3) and `resolveClerkCarrierMembership`, `assertCallerInCarrierOrg` Path 2, `requireCapability` Clerk branch to one `orgMemberships` read. `assertCallerInCarrierOrg` Path 1 (org-claim match with **no permission check**) gets a permission check.
6. **Staff guard.** `requirePlatformStaff` compares issuer strings; add the test twin of `platform/access.test.ts:62-79` for the new issuer.
7. **Audit attribution.** `name`, `email` on every token; fix `payProfiles.resolveActorName:761` (D32).
8. **Location holes (D22).** `driverLocations.batchInsertLocations` deleted; `/v1/mobile/locations` on bearer; `ingestBatch` takes `driverId`/`organizationId` from the caller and verifies `sessionId` ownership. `s3Upload` presign endpoints gain a caller-org / assignment check.
9. **Phone-fallback auth lookups removed.** `drivers.by_phone` and the import/dedupe uses stay. `carrierPartnerships.ts:2350` full-table scan goes with `userIdentityLinks`.
10. **One caller helper, enforced by lint.** ESLint `no-restricted-syntax` forbids `ctx.auth.getUserIdentity` outside `convex/lib/auth.ts` and `convex/lib/mobileAuth.ts` (18 sites in 10 files migrate), and forbids `identity.subject` outside those files (21 sites).
11. **Driver tokens never satisfy the org-member helpers (D36).** Test: a `kind: ['driver']` token against `requireCallerOrgId`, `assertCallerOwnsOrg`, `assertOrgPermission`, and one representative web query per helper must throw. This is the single most important regression test in the change.
12. **Carrier roles map to permissions (D37).** `isPermitted` recognizes only the lowercase `admin` slug and a `permissions` array; carrier memberships carry `OWNER | ADMIN | MEMBER`. Add `permissionsForCarrierRole(role)` in `convex/lib/permissions.ts`: OWNER/ADMIN → every capability slug (today `requireCapability` grants owner-operators everything), MEMBER → the dispatcher preset from the dispatch split plan. The issuer stamps that array into `permissions` for `source: 'local'` members so `resolveOrgForRead` and `assertOrgPermission` need no carrier special case.

---

## 10. Web app

### 10.1 Settings → Mobile access (new page, D9)

- Route `app/(app)/settings/mobile-access/page.tsx` (client component like its siblings; no shared settings shell exists). Nav item in `components/web/shell/nav.ts` settings section.
- Sections: **Drivers** (gated `fleet:manage`) and **Team members** (gated `team:manage`) — D19. The nav item carries `area: 'team'` (nav supports one area per item); the page renders whichever sections the caller's permissions allow and an empty state if neither.
- Per row: name, devices (platform, device name, app + version, enrolled via, last seen, status), last link delivery status, opt-out flag; actions: **Send link (SMS)**, **Show code**, **Revoke device**, **Revoke all**.
- **Add this phone** (QR + code) for the current member.
- Reads use one-shot or narrow queries (`devices.by_orgkey_status`); `lastSeenAt` is a throttled write so subscribing here is safe.
- Audit via `auditLog` for send, enroll, revoke.

### 10.2 Driver profile (`app/(app)/fleet/drivers/[id]/page.tsx`)

- Replace the "Mobile app access" card (`:1031-1107`: Clerk chip, raw `clerkUserId`, "Resync to Clerk") with a read-only device summary + "Manage in Settings" link. Remove the `clerkSyncStatus === 'failed'` attention band (`:766-773`). Remove `convex/drivers.ts.resyncToClerk`.

### 10.3 Team page and routes

- `app/api/team/members/[membershipId]/route.ts:69-73,95` (deactivate/reactivate/delete) call `deviceAuth.revokeForMember({ workosUserId })` through `ConvexHttpClient` with the caller's WorkOS token. The mutation re-checks on the Convex side that the caller holds `team:manage` (`assertOrgPermission`) and that the target's `orgMemberships` row is in the caller's org; it never trusts the route. Failure of that call is logged, not fatal to the WorkOS action, and the refresh path (D23) is the backstop.
- Kebab menu gains "Manage devices" → Mobile access page.

### 10.4 Platform console (`apps/admin`)

- `OrgSupportPanels.tsx` `DriversPanel` + `IdentityLinksPanel` → `DevicesPanel`: list devices per org/driver/member, send link on behalf (audited, reason required), revoke, delivery status. `convex/platform/support.ts` §Identity links + §Clerk resync replaced; `recordActionAudit` union extended. `platform/orgs.getOrgDetail` returns memberships + devices instead of `identityLinks`/`clerkOrgId`.

### 10.5 WorkOS webhooks (D23 follow-on, trailing)

- Route in `convex/http.ts` per the Stripe pattern (raw body first, 501 when the secret is missing, 200-ack unknown events). Backfill from `listOrganizationMemberships`. Drift cron.

---

## 11. Mobile apps

### 11.1 `packages/mobile-core/auth` (new, shared)

- `enroll({ token | code, deviceInfo })`, `getAccessToken({ forceRefresh })`, `getAccessTokenHeadless()`, `refresh()`, `signOut()`, `onAuthStateChange`.
- Reuse the dispatch app's `TokenSource` interface (`apps/dispatch/lib/auth/token-source.ts:33-38`) as the React-facing contract; add the headless accessor it lacks.
- Token cache + near-expiry refresh + debounce; storage per §6.4; response-code → state mapping (§11.4).
- **Headless mutation processor**: a `ConvexHttpClient`-backed processor registered at module init so `offline-queue.processQueue` works from `background-sync.ts` (today it silently no-ops headless).

### 11.2 Driver app

Remove: `ClerkProvider` + `tokenCache` + the module-scope throw on the Clerk key (`app/_layout.tsx:121-172`), `@clerk/clerk-expo`, `@clerk/types`, `auth-token-store.ts`, the recovery state machine in `lib/convex.tsx`, `useConnectionRecovery` auth paths, loading-gate reauth paths, `LoadingGate 'clerk_load'`, `sms-otp.ts` + `modules/expo-sms-retriever` (native module → goes with the store build), `(auth)/sign-in.tsx`, `(auth)/verify.tsx`, `expo-auth-session` (unused), the `MOBILE_LOCATION_API_KEY` read and the `skipped_no_key` outcome, the `.env` note about EAS-only secrets for it, the `feature-flags.ts` retry ladder for "Clerk singleton not loaded".
Add: `(auth)/enroll.tsx` (link/QR/code), `(auth)/code-entry.tsx`, `(auth)/contact-admin.tsx`, `(auth)/access-removed.tsx`, Scan QR. expo-router handles `/enroll?t=` for both the custom scheme and, later, the Universal Link.
Change: `useBootstrap` reads `kind`/org from the token instead of Clerk `organizationMemberships`; `getUserRoles` query replaced by `resolveCaller`-backed `getMyAccess`; `useAnalyticsInit` identifies with `sub`; `complete-driver-profile.tsx` prefill from token claims; `performSignOut` takes the session revoke instead of Clerk `signOut`; `location-tracking.ts` collapses the three sync paths (React client race, Clerk-token HTTP client, static-key route) to one bearer HTTP path; `yard-fences.ts` and `feature-flags.ts` use `getAccessTokenHeadless`.
Keep: role switch until the dispatch split removes owner mode.

### 11.3 Dispatch app

Remove: Clerk (4 files), `workos-token-source.ts`, `expo-auth-session`, `expo-web-browser` plugin, the hardcoded key fallbacks in `lib/env.ts:18-23`.
Add: the shared enrollment screens; `logout.ts` equivalent; `keychainAccessible` on SecureStore writes.
Keep: `DispatchAuthProvider` shape with a single `TokenSource`.

### 11.4 App auth states

| State | Trigger | Screen |
|---|---|---|
| `unenrolled` | no refresh token | Enroll: code entry + Scan QR + "I don't have a code" → contact admin / self-service |
| `authenticated` | valid session | app |
| `offline_stale` | expired access token, refresh unreachable | app + `OfflineIndicator`; no auth gate |
| `revoked` | `session_revoked` / `member_removed` | Access removed, admin name, request code |
| `dormant` | `device_dormant` | same, different copy |

### 11.5 Native build requirements (not in the 24h window)

- Associated domains (iOS) + App Links with `autoVerify` (Android) → new EAS build, store review, for both apps. The SMS-retriever module removal rides the same build.
- AASA and `assetlinks.json` per environment on the link domain.

---

## 12. Twilio checklist

- Account, messaging service, **10DLC brand + campaign** — start week 1.
- Own short link domain, never a public shortener.
- STOP/HELP webhook → `opted_out`; status callback → `deliveryStatus`. Both routes follow the EAS-webhook shape in `convex/http.ts:229-331` (raw body, constant-time compare, 200-ack), but Twilio's signature is HMAC-SHA1 over the **full request URL plus the sorted form parameters** with the account auth token, not over the body alone. Verify with the exact public URL Twilio was given.
- Templates EN/ES; org name; first name only.
- Rate limits per driver (3/h), per org (100/day).
- International (D29).

---

## 13. Deep links

- Domains `go.otoqa.com` / `go-staging.otoqa.com`; AASA paths `/e/*`; `assetlinks.json` with both apps.
- Landing page `/e/<token>`: shows the code always; opens the app when installed; store badge otherwise.
- The typable code is the guaranteed path; Universal Links are the convenience layer.

---

## 14. Cutover (24-hour window, no active drivers)

Preconditions: audits done (§24), all open questions resolved (§4, D23–D32), `orgMemberships` backfill script tested against a prod snapshot, all 47 test files on the shared fixture (D21), device matrix passed on preview builds, the cutover-day non-`+1` phone check (D29) run.

Order of operations, each step green before the next:

1. **Schema push (additive).** New tables; `orgMemberships`; every to-be-dropped field made optional (`userIdentityLinks.clerkUserId` included).
2. **Backfill.** `userIdentityLinks` → `orgMemberships` (`source: 'local'`); `orgMembers` → `orgMemberships` (`source: 'workos'`). Verify counts; `platform/snapshots` `membershipCount`.
3. **Deploy functions.** `resolveCaller`, rewritten helpers (§9), issuer + JWKS, enrollment/refresh/revoke, settings page APIs, `/v1/mobile/locations` on bearer, `auth.config.ts` with the new provider and **without** Clerk. Web deploy with the settings page and team-route hooks. From this moment until step 5, internal testers' Clerk sessions are rejected; that is the expected gap, not an incident.
4. **Apps.** Publish JS via `eas update` (with the `.env.local` rule from the dispatch plan) for both apps; native build submitted in parallel for §11.5.
5. **Re-enroll internal testers** (QR / code). Verify background location on a locked iPhone, revoke, offline > 12h.
6. **Strip and empty migrations** (`019_strip_driver_clerk_fields`, `020_strip_org_clerk_org_id`, `021_empty_user_identity_links`, `022_empty_org_members`), each verified with a count, then the schema push dropping `drivers.clerk*`, `organizations.clerkOrgId` + `by_clerk_org`, `userIdentityLinks`, `orgMembers`. Convex refuses to drop a table that still has rows.
7. **Decommission** (§16): delete Clerk code, env vars, dependencies, `MOBILE_LOCATION_API_KEY`.

Rollback within the window: redeploy the previous Convex functions and `auth.config.ts` (Clerk provider restored), republish the previous app bundle. Steps 6–7 are only run after step 5 passes, so rollback never has to restore dropped fields.

---

## 15. Security controls and threat comparison

| Risk | Today | Proposed | Delta / control |
|---|---|---|---|
| Lost or stolen unlocked phone | session persists | credential persists | Same. Passcode + admin revoke; optional biometric on pay screens (D15). |
| SIM swap / SMS interception | every login exposed | enrollment only | Better. |
| Driver forwards the link/code | n/a | possible | single-use, short TTL, first-device binding, admin notified, one device per principal. |
| Admin sends to wrong number | wrong person gets OTP | wrong person enrolls | Same; landing shows first name; device appears live. |
| Terminated driver keeps access | if nobody deletes them | if nobody deactivates them | Same; revocation tied to deactivation. |
| QR photographed off a screen | n/a | possible | 2-min TTL, self-only minting, live revoke. |
| Bugs in our crypto / rotation | Clerk's | ours | `fcmWake` signing pattern, standard rotation + grace, tests. |
| Public sign-in endpoint abuse | exists | none | Better. |
| Anyone with the app binary writes GPS for any org | **exists today** | closed | D22. |
| Any authenticated token writes GPS for any org via the fallback mutation | **exists today** | closed | D22. |
| Missing/malformed permissions claim → full access | **exists today** | closed | §9.1. |
| Signing key compromise | n/a | ours | env custody, `kid` rotation runbook, revoke-all tool. |

Questionnaire answer: "Device-bound credential established through admin-controlled enrollment, server-side revocation on every request, full audit trail, optional biometric step-up."

---

## 16. Decommission checklist

- `convex/clerkSync.ts` (1,376 lines, 12 handlers), `clerkSyncScheduler.ts`, `clerkSyncHelpers.ts`, all `scheduleXxxClerkUser` call sites in `drivers.ts`, `carrierMobile.ts`, `carrierPartnerships.ts` (5 org-creation sites), `maintenance.ts` (`syncCarrierOwnerToClerk`, `syncAllCarrierOwnersToClerk`), `platform/support.ts` §Identity links + §Clerk resync, `platform/health.ts:222` Clerk dependency row, `lib/externalHealth.ts:63`.
- `convex/drivers.ts.resyncToClerk` and its `[clerkSync.driver]` log line; `auth.config.ts` Clerk block; `CLERK_ISSUER_URL`, `CLERK_SECRET_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `eas.json` (driver ×4 profiles, dispatch ×2), `.env`, `.env.example`; the Clerk SMS template.
- `driverMobile.resolveAuthenticatedDriver`, `carrierMobile.requireCarrierAuth`, `carrierMobile.getUserRoles`, `lib/auth.resolveClerkCarrierMembership`, `_helpers/mobileAuth.normalizePhoneForMatch` (auth use).
- `drivers.clerk*` (4 fields), `organizations.clerkOrgId` + `by_clerk_org` (`lib/orgLookup.ts:21-25`, ~35 `carrierPartnerships.ts` sites), `userIdentityLinks` (50 refs), `orgMembers` (8 readers), `orgHealthSnapshots.identityLinkCount`, `schema.ts` comments at `:530, :544, :1922, :4264, :4345, :4355`.
- Driver app: `@clerk/clerk-expo`, `@clerk/types`, `expo-auth-session`, `auth-token-store.ts`, `sms-otp.ts`, `modules/expo-sms-retriever`, `(auth)/sign-in.tsx`, `verify.tsx`, recovery machine, `LoadingGate 'clerk_load'`, `MOBILE_LOCATION_API_KEY` + `.env` note + `skipped_no_key` outcome.
- Dispatch app: `@clerk/clerk-expo`, `workos-token-source.ts`, `expo-auth-session`, `expo-web-browser` plugin, `lib/env.ts` fallbacks, `(auth)/sign-in.tsx` OTP branch, `(auth)/staff.tsx`.
- Web: driver-profile Clerk card and attention band; `apps/admin` `DriversPanel`/`IdentityLinksPanel`; `hooks/use-org-member-sync.ts` + `app/api/organization/members/sync` repointed to `orgMemberships`.
- PostHog: `sign_in_*`, `verification_*`, `convex_auth_*` → `enroll_*`, `device_auth_*`.
- Docs: `security-review.md` (L11 framing; findings at L273-274 close with the file), `dispatch-app-split-plan.md` (D4, D5, §3.4 Clerk production-instance migration, §4.2 parity rule, Phase 0 gating item, OQ-1/2), `platform-admin-console-plan.md` (L206, L212, L356, L363), `platform-admin-ops-readiness-plan.md` (L19, L239), `documents-storage-spec.md:396`, `end-shift-reminder-spec.md:203`. New runbook: `docs/runbooks/mobile_enrollment.md`.

---

## 17. Cost (Convex)

Not verified against the pricing page (egress blocked); confirm before quoting.

| Operation | Convex calls | Cadence |
|---|---|---|
| Refresh (validate, rotate, sign) | ~3 | once per 12h per live device |
| Revocation read | 0 extra calls, 1 primary-key read | every authenticated mobile request |
| Location ingest auth | 1 primary-key read per batch (new; the path did zero auth reads before) | every 30s while tracking + background fires |
| JWKS fetch | cached | rare |
| Enrollment | ~2 + Twilio | once per device |
| Cleanup cron | 1 | daily |

| Enrolled active devices | Auth calls / month (12h token) |
|---|---|
| 10 | ~2,000 |
| 500 | ~90,000 |
| 5,000 | ~900,000 |

Net effect on the identity prologue: today `resolveAuthenticatedDriver` does 1–3 index reads and `getUserRoles`/`resolveClerkCarrierMembership` up to 4 + org gets; `resolveCaller` does 1. The ingest path gains 1 read per batch on top of its per-ping work. Neither moves the bill.

---

## 18. Store review

- Reviewer code via code entry, stated in App Review notes.
- Account deletion: accounts are admin-created; document the sign-out + admin-deletion path.
- Associated domains → full review, not OTA.

---

## 19. Telemetry

- `enroll_started` (channel), `enroll_succeeded`, `enroll_failed` (reason), `device_auth_refresh` (code, elapsed), `device_auth_revoked_seen`, `device_auth_offline_stale`.
- Settings page reads `lastSeenAt`.
- Alerts: refresh failure rate per app version; SMS undelivered rate.

---

## 20. Testing

- **Shared fixture** `convex/_helpers/testIdentity.ts`: `driverIdentity()`, `memberIdentity()`, `workosIdentity()`, `staffIdentity()`; migrate all 47 files (414 sites). Delete the hardcoded Clerk issuer strings in `mobileSettlements.test.ts:263,284,297` and `platform/access.test.ts:18,77`.
- Unit (convex-test): exchange (single-use, expiry, wrong org, code vs token), refresh rotation incl. replay inside/outside grace, revocation through `resolveCaller` in query/mutation/action contexts, `isPermitted` per issuer incl. malformed claims, staff guard rejects our issuer, every §9 branch with `kind` tokens, `orgMemberships` backfill, strip migrations (co-locate tests like `018_*`).
- Client: token cache near-expiry, debounce, headless access, headless mutation processor, state machine.
- Device matrix: iOS locked-device background refresh and location upload; Android reinstall → re-enroll; QR scan; code entry; offline > 12h then reconnect; revoke while foregrounded / backgrounded; dispatch member enroll by QR.
- `npm ci`, not bun (dual-lockfile hazard).

---

## 21. Workstreams and sequencing

Long-lead items (W0) start on day 1. Everything else lands in the cutover window.

| # | Workstream | Depends on | Rough size |
|---|---|---|---|
| W0 | Twilio + 10DLC, short domain, AASA/assetlinks, STOP/HELP + status webhooks | — | 2–3 days of work, **weeks of waiting**; not gating the cutover |
| W1 | Signing spike only (D33): RS256 via the `fcmWake` pattern, JWKS export, `customJwt` provider round-trip in a dev deployment, WorkOS REST from a Node action with `WORKOS_API_KEY` | — | 1 day |
| W2 | Shared test fixture + migrate 47 files (D21) | — | 2 days |
| W3 | Authorization rewrite (§9): `resolveCaller`, six `kind` branches, `isPermitted`, `lib/auth.ts` issuer delegation, lint rule | W2 | 4–5 days (was 2–3; 26 + 20 + 6 + 18 sites) |
| W4 | `orgMemberships`: schema, backfill scripts, repoint 8 `orgMembers` readers + 50 `userIdentityLinks` refs, **sync rewritten as a Node action with `WORKOS_API_KEY` (D34)**, `getUserRoles` collapse | W3 | 4–5 days |
| W5 | Issuer: tables, enroll/refresh/revoke, JWKS, cleanup cron, rate limits, key-rotation runbook | W1, W3 | 3–4 days |
| W6 | `packages/mobile-core/auth` incl. headless accessor + headless mutation processor | W5 | 3 days |
| W7 | Driver app (§11.2) incl. the location sync collapse | W6 | 4–5 days |
| W8 | Dispatch app (§11.3) | W6 | 2 days |
| W9 | Web: Mobile access page, driver-profile card, team-route hooks, nav | W5 | 4 days |
| W10 | Platform console DevicesPanel + support tools | W5 | 1–2 days |
| W11 | WorkOS webhooks + DB authorization for members (D23 follow-on) | W4 | 3 days, trailing |
| W12 | Strip migrations, schema drops, decommission (§16), docs | cutover | 3 days |
| W13 | `/v1/mobile/locations` on bearer; delete `batchInsertLocations`; `s3Upload` presign checks; `ingestBatch` ownership check (D22) | W6 | 1–2 days, ships with W7 |
| W14 | Native builds (entitlements, module removal), device matrix, store submission | W7, W8, W0 | 3–4 days + review; trails the cutover |

Roughly **4 engineer-weeks** for W1–W10 + W12–W13 (up from 3; the authorization rewrite and `orgMemberships` are larger than v0.2 assumed). W11 and W14 trail.

---

## 22. Risks

- **Mobile auth is the most sensitive thing to ship, and there is no dual-provider safety net now.** Mitigation: the ordered cutover in §14 with a same-day rollback (previous functions + previous bundle), device matrix before step 3, no data drops until step 6.
- **The authorization rewrite touches ~70 mobile call sites and six web-visible branches.** Mitigation: W2 first so every branch has a fixture; the lint rule prevents regression.
- **`orgMemberships` backfill correctness** (the `pending_*` sentinel rows, owner-operator links, partnership-created orgs). Mitigation: dry-run against a snapshot, count verification, never delete during login sync.
- **10DLC approval slips.** Mitigation: codes and QR work without SMS; email link interim for drivers with email.
- **Universal Link flakiness.** Mitigation: code entry always works.
- **Refresh rotation lockout.** Mitigation: grace window + tests; admin "send new code" backstop.
- **Permission freshness for members** until W11. Mitigation: refresh-time WorkOS check with bounded grace (D23).
- **Refresh reuse detection false positives** (a driver's phone retries an old token after a long dead zone). Mitigation: the 60s grace covers network retries; a reuse revocation shows "Access removed, request a new code", which the admin can resolve in seconds, and the audit row says why. Tune the grace window from telemetry (`device_auth_refresh` codes) before widening it.

---

## 23. Schema and platform review (v0.2)

### 23.1 Reactivity: the v0.1 design would have re-run every mobile query on every refresh

v0.1 put rotation state and last-seen on the doc the auth helper reads. Every query subscribes to every doc it reads; a write re-runs all subscriptions. Fixed: `deviceSessions` written only on create/revoke; rotation state in `deviceRefreshTokens`; `lastSeenAt` throttled and never touched by the helper; `sid` is the doc id (primary-key get).

### 23.2 Two membership tables were about to become three

Superseded by D18 in v0.3: one new table, both old ones retired.

### 23.3 Push tokens would have been duplicated

Removed from `devices`.

### 23.4 Org identity: three identifiers already, don't add a fourth

Token `org_id` = `workosOrgId` or `organizations._id`; new tables carry `organizationId` + `orgKey`. Platform-wide consolidation is a separate project.

### 23.5 Nothing goes on `drivers`

### 23.6 Dual-path helpers become permanent unless fenced

`resolveCaller` + lint rule. (The `legacy/clerk` folder is gone with D10.)

### 23.7 Schema drops need migrations, not edits

### 23.8 Effects on the rest of the platform

| Area | Effect | Handling |
|---|---|---|
| Mobile queries/mutations | one primary-key read in the prologue, replacing 1–4 index reads | net reduction |
| Query subscriptions (mobile) | one extra dependency that changes only on revoke | free in steady state |
| `lib/auth.ts` helpers, 22 action call sites | unchanged signature; issuer branch; `runQuery` in actions for our tokens only | no web impact |
| Web auth, staff console | none | `isPermitted` legacy rule scoped to WorkOS issuers |
| Web team page, audit display names | `getMemberDisplayMap` repointed | additive |
| Location ingest | first auth read on the hottest path; two holes closed | 1 read per 30s batch |
| Platform console | panels replaced | W10 |
| Crons, internal functions, external tracking API | none | — |
| Rate limiter | named limits added to the existing instance | shared component |
| Dispatch split plan | D4/D5/§3.4 superseded | update at W12 |
| PostHog | subject changes; no aliasing (no real users) | — |

### 23.9 Cleanup already owed, surfaced by this review

Folded into §16.

---

## 24. Code audit findings (v0.3)

Four audits on 2026-09-10: Convex auth consumers, mobile apps, web + platform console + tests, schema + hot paths. Each finding names what changed.

### 24.1 The revocation check was going into the wrong place

v0.2 put it in `convex/lib/auth.ts`. Driver-app traffic never goes there: it goes through `driverMobile.resolveAuthenticatedDriver` (26 sites) and `carrierMobile.requireCarrierAuth` (20 sites). And `lib/auth.ts` is typed `AnyCtx` with 22 action call sites that would not compile with a `ctx.db.get`. Fixed by D17: `resolveCaller` is the mobile entry point and carries the check; `lib/auth.ts` delegates by issuer with a runtime ctx branch.

### 24.2 "No org claim means driver" is load-bearing in six places

Listed in §1.4. With `org_id` on every token, `getDocForAccess` would have either denied all driver document reads or widened them to every document in the org, and `resolveOrgForRead` would have thrown "not provisioned" for carrier-only orgs. Fixed by D16 and §9.2.

### 24.3 `clerkOrgId` is never written

Every carrier org already uses `_id` as its external id, and identity links start life with a `pending_<digits>` sentinel. OQ-12 resolved; the `by_clerk_org` index and ~35 `carrierPartnerships.ts` sites are edited in W4.

### 24.4 The membership table should be new, not evolved

`orgMembers` is keyed on a WorkOS org string (carrier-only orgs can never have rows), has no role/status/delete, and its login sync is best-effort with swallowed errors and a 2000-row cap; three sync paths disagree on the no-org-claim fallback. D18 replaces it and `userIdentityLinks` with `orgMemberships`; the sync stays upsert-only.

### 24.5 The permission rule has two holes, not one

`permissions == null` grants everything, and a malformed claim is coerced to `undefined` and grants everything. Four paths grant with no permission check regardless. §9.1 and §9.5.

### 24.6 The location path has two authorization holes today

Static key in the binary + client-supplied org on the HTTP route; identity-presence-only + client-supplied org on the fallback mutation; presence-only on presign. D22 closes them in this change.

### 24.7 The mobile token mirror is plaintext AsyncStorage

And the background-fetch task cannot authenticate at all. §6.4 and §11.1.

### 24.8 A new RBAC area would be silently ungated

The seeder never back-fills existing populated roles; legacy tenants get everything. D19 reuses `fleet:manage` and `team:manage`.

### 24.9 RS256 signing in V8 already exists

`fcmWake.ts` is the template. D20.

### 24.10 Tests have no shared identity fixture

47 files, 414 sites, `as never` casts. D21, W2 first.

### 24.11 Smaller items folded in

Dispatch hardcoded key fallbacks; dispatch SecureStore without accessibility class; dispatch has no logout teardown; `expo-auth-session` unused in the driver app; `expo-linking` never imported; `carrierPartnerships.ts:2350` full-table scan; `platform/support.recordActionAudit` single-literal union; `payProfiles.resolveActorName` `user_` prefix heuristic; `orgHealthSnapshots.identityLinkCount`; `platform/health.ts` Clerk dependency row; `comments.authorId` edit gate keyed on subject; six docs with stale Clerk sections; no mobile sign-in runbook.

---

## 25. Confidence review (v0.5)

An adversarial pass over v0.4 asking, for each mechanism, "what would make this fail in production, leak access, or slow the platform." Score before the pass: **6/10**. Score after: **8/10**. What was found, what changed, and what still caps the score.

### 25.1 Found and fixed

| # | Issue in v0.4 | Why it mattered | Fix |
|---|---|---|---|
| 1 | Refresh grace said "return the successor pair again" on a replay. | Raw refresh tokens are never stored (only hashes), so the server cannot re-return one. As written, every lost-response retry would have locked the device out — the exact race the grace window exists to prevent. | §6.3 rewritten: replay-in-grace invalidates the unused successor and rotates again; any other superseded/invalidated token = reuse → revoke the family (D35). `usedAt`, `invalidated` state, `token_reuse` reason added to the schema. |
| 2 | `orgMemberships` was to be authoritative for mobile authorization, but its WorkOS rows were written by the existing `orgMembers.syncMembers`, a **public mutation that trusts a client-supplied member array**. | Any authenticated web member could call it directly and write themselves `admin`; after W11 that would grant mobile dispatch permissions. The current code's comment defends it as "display-only either way", which stops being true the moment `role` lands on the row. | D34: sync becomes an `internalMutation` fed only by a Convex Node action that fetches memberships and role→permission maps from the WorkOS REST API with a server `WORKOS_API_KEY`. Public surface is a data-free `requestSync`. Same action serves D23. |
| 3 | No brute-force control on the typed enrollment code; Convex exposes no client IP, so the usual per-IP limit is unavailable. | 40-bit codes are strong, but "no control" is not a security posture, and a spray would have been invisible. | §7.1: global failed-enrollment bucket with a platform alert, per-code burn after 5 attempts, uniform error responses, per-`sid` refresh bucket. |
| 4 | Post-W11 the helper reads `orgMemberships` on every member request, and the sync would have bumped `syncedAt` on every web login. | Every open dispatch app subscribes to that row; a per-login write re-runs all of them — the same reactivity hazard §23.1 fixed for `deviceSessions`. | Rule 8 in §5.2: patch only on real change, no sync timestamps on the row, bookkeeping in `orgMembershipSyncs`. |
| 5 | Cutover step 6 dropped `userIdentityLinks` and `orgMembers` from the schema after backfill. | Convex refuses to remove a table that still holds rows; the push would have failed mid-window. | Empty-table migrations `021`/`022` with count verification before the schema push. |
| 6 | Dormancy relied on a sweep writing `devices` status. | A sweep is a housekeeping job; security should not depend on it running. | Refresh tokens expire 90 days after rotation; the sweep only updates the display status. |
| 7 | The Convex Auth spike (D14) left the token design forked until the spike ran. | Every downstream workstream depends on the claim shape and revocation semantics; a late switch would have re-opened §5–§11. | D33: hand-rolled, spike dropped, W1 is a one-day signing round-trip. |
| 8 | JWKS "static file on Vercel" without saying where. | A preview URL or a protected deployment would make Convex unable to fetch keys → every mobile token rejected. | §6.2: production domain, `.well-known`, public, no protection. |
| 9 | Team-route revoke hook passed a WorkOS user id through `ConvexHttpClient` with no statement of server-side checks. | The route is authenticated, but the mutation must not trust it; cross-org revocation would otherwise be one crafted call away. | §10.3: mutation re-asserts `team:manage` and same-org target. |
| 10 | D23 and D34 both need WorkOS API access from Convex, which does not exist today (`WORKOS_API_KEY` lives only in `lib/workos.ts` on the web side). | An unstated new dependency on the cutover day. | Named in D34 and W1; env var on the deployment; REST via `fetch` in a Node action, no SDK added to Convex. |

### 25.2 What keeps it at 8 rather than 9–10

- **Nothing is built or measured.** The per-request primary-key read, the reactivity claims, and the ~150ms signing cost are reasoned from code and Convex semantics, not observed under load. W1 and the device matrix convert reasoning into evidence.
- **The authorization rewrite is large** (~70 mobile call sites, six web-visible branches, 47 test files). The lint rule and shared fixture reduce regression risk; they don't remove it. A second reviewer on the `resolveCaller` diff is worth the hour.
- **External gates are outside our control**: Twilio 10DLC approval and store review for associated domains. Codes and QR make them non-blocking, but one-tap SMS is not day-one.
- **WorkOS as a refresh-time dependency for members** (D23) is a deliberate, bounded regression of goal 5 ("no third party on the mobile critical path") until W11 lands. Drivers are unaffected.
- **Grace-window tuning** (60s) is a guess. Too short creates false reuse revocations for drivers in dead zones; telemetry decides.

### 25.3 What would take it to 9

W1 done (signing + `customJwt` round-trip + WorkOS REST from Convex), the device matrix passed on a preview build including the locked-iPhone background upload, and W11 shipped so member authorization no longer touches WorkOS at refresh.

### 25.4 Second pass (v0.6)

Re-read of the whole document after the v0.5 edits, looking for seams between sections edited independently. Score going in: **7/10** — the v0.5 score of 8 was too generous, because item 1 below was already present in v0.5 and is the most serious finding of any pass. Score after: **8/10**.

| # | Issue in v0.5 | Why it mattered | Fix |
|---|---|---|---|
| 1 | D16 put `org_id` on every token, and §6.5 had the shared helpers delegate to `resolveCaller` for our issuer — with nothing saying drivers must still fail them. | Today a driver token has no org claim and is rejected by all ~530 functions behind `requireCallerOrgId` / `assertCallerOwnsOrg`. As written, an enrolled driver could have called any org-scoped web query — loads, customers, other drivers' SSN/license data — scoped to their own org. A silent, org-wide authorization regression introduced by the very change meant to tighten auth. | D36: the org-member helpers require `kind ∋ member`; `getCallerOrgId` is null for drivers; driver access only via explicit `resolveCaller({ allow: ['driver'] })`. §9.11 makes it the headline regression test. |
| 2 | Carrier members carry `OWNER/ADMIN/MEMBER` roles; `isPermitted` recognizes only the lowercase `admin` slug and a `permissions` array. | Owner-operators using the dispatch app would have been denied every capability the moment their tokens went through `resolveOrgForRead` on the claim path. | D37: role → permission-slug map stamped at mint time for `source: 'local'` members. |
| 3 | The v0.5 refresh flow read state, decided, and wrote in separate steps inside an action. | Two headless tasks refreshing at once (separate JS contexts on Android; the location task and the FCM task both call the headless accessor near expiry) could both rotate; the loser's next refresh would then be flagged as reuse and the driver locked out. | D38: one atomic `rotateRefreshToken` mutation; grace covers the whole family within 60s of the last rotation. |
| 4 | "Burn a code after 5 attempts" in §7.1. | A wrong guess matches no code, so there is nothing to burn; the control was fictional. | Replaced by a per-`installId` bucket; the global bucket and alert remain the real control. |
| 5 | Org lookups for carrier-only members. | `resolveOrgForRead` keys `organizations.by_organization` on `workosOrgId`; carrier-only orgs have none. §9.2 said "key on kind first" without saying how the org is then found. | §6.5: our tokens carry the Convex `organizationId` claim; helpers `ctx.db.get` it and never touch the WorkOS-id index. |
| 6 | Access token in SecureStore with no size bound. | `expo-secure-store` is unreliable above 2 KB on iOS; a member token with 24 permission slugs is ~1.4 KB and would grow with the catalog. | §6.4: mint-time size assertion; fallback to `role` + version with DB-side permissions. |
| 7 | D34 said "Node action" for the WorkOS REST calls. | Unnecessary: `fetch` works in V8 actions, and Node actions add cold starts. | D34 corrected to a V8 action, no SDK. |
| 8 | QR flow said "claims copied from the member's live WorkOS session" without saying where they live between mint and exchange. | Storing role/permission claims on `enrollmentTokens` would create a second place authorization data lives. | §7.3: the token stores only `membershipId`; the exchange reads the membership row. |
| 9 | Twilio webhooks were told to follow the EAS HMAC pattern. | Twilio signs URL + sorted params, not the body; copying the EAS verifier would reject every callback. | §12 corrected. |
| 10 | Cutover step 3 removes the Clerk provider before step 4 republishes the apps. | Internal testers lose access for the gap; without saying so, someone would treat it as an incident and roll back. | §14 step 3 states the expected gap. |

What still caps the score at 8 is unchanged from §25.2: nothing is built or measured, the authorization rewrite is large, and two external gates sit outside our control. Item 1 above is also the reason the `resolveCaller` diff should get a second reviewer before it merges: the plan now says the right thing, but the mistake was easy to make once and will be easy to make again in code.
