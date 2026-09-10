# Mobile Device Auth — Replace Clerk with device-bound credentials

> Status: **v0.2 rough draft, schema-reviewed** — captures the 2026-09-10 discussion end to end. Nothing here is built. Open questions in §4 need answers before schema work starts; everything else is a decision already taken (§3) or a fact verified in the codebase or PostHog (§1). v0.2 reworked §5–§6 after a review for reactivity, tech debt, and platform-wide effects (findings in §23).
>
> Scope: **Otoqa Driver** and **Otoqa Dispatch** mobile apps, the web **Settings → Mobile access** page, and the platform console's mobile tooling. The web app and the staff console **stay on WorkOS**.
> Backend: the single shared Convex deployment (topology unchanged).

---

## 0. Summary

Today the mobile apps sign in through Clerk phone OTP (driver app, and owner-operators in the dispatch app) and an unfinished WorkOS PKCE scaffold (in-house dispatchers in the dispatch app). Every fresh token is a network round trip to a third party, and the driver app carries a large recovery state machine to survive that.

The plan: Otoqa becomes the token issuer for mobile. A device is **enrolled once** through a one-time enrollment token (delivered by SMS for drivers and carriers, or by QR code for members who are logged in on the web), receives a **device-bound credential**, and stays signed in until an admin revokes it. Convex validates the resulting JWTs through the same `customJwt` mechanism it already uses for WorkOS.

What we get: one-tap sign-in with no code entry, the structural removal of the failure class that generated ~245k token-fetch failures in July–August, deletion of the Clerk sync and recovery code, explicit admin control over devices, and no public sign-in surface at all. Convex cost is unchanged at any realistic scale.

---

## 1. Evidence (verified)

### 1.1 Current auth topology

| Surface | Provider | Notes |
|---|---|---|
| Web (`app/`, Next.js) | WorkOS AuthKit, Google Workspace SSO | Also the source of truth for org membership, invitations, roles, RBAC permission claims. ~25 SDK call sites. **Unchanged by this plan.** |
| Staff console (`apps/admin`) | Separate WorkOS project, authorized by issuer in `requirePlatformStaff` | **Unchanged.** |
| Driver app (`apps/driver`) | Clerk phone OTP (`@clerk/clerk-expo`) | `clerkSync.ts` creates Clerk users from driver records by phone; `userIdentityLinks` maps `clerkUserId` → org. |
| Dispatch app (`apps/dispatch`) | Clerk OTP for owner-operators; WorkOS PKCE scaffold for staff | The WorkOS token source is marked "device-validation pending — treat as scaffold". It has never been validated on a device. |
| Convex | `convex/auth.config.ts` | Two WorkOS `customJwt` providers, one Clerk domain provider, one optional staff provider. Multiple providers coexist — this is what makes a dual-provider migration possible. |

### 1.2 The Clerk failure data (PostHog, `convex_auth_token_fetch_failed`)

| Window | Failures | Devices | Dominant error |
|---|---|---|---|
| July 2026 | 84,000 | 3 | `null_token_after_retry` |
| August 2026 | 161,000 | 5 | `null_token_after_retry` |
| Since ~Aug 23 | < 10 / day | 1–3 | mix of null token (background, iOS) and Clerk `signed_out` 401s |

- All on iOS, from 3–5 phones. The volume is a **retry loop** (the app repeatedly asked Clerk for a token and got `null`), not 245k distinct incidents.
- Dropped to near zero around Aug 23, so a build change already tamed the storm. September residue carries the new diagnostic properties (`app_state`, `has_cached_token`, `force_refresh`).
- Root causes are structural to a remote token minter: Clerk unreachable while Convex is reachable; session not hydrated when a background task wakes; Clerk's own session lifecycle (`signed_out`); keychain unreadable while locked (already mitigated with `AFTER_FIRST_UNLOCK` in `apps/driver/app/_layout.tsx`).

### 1.3 Scale today (PostHog, last 30 days)

| Metric | Value |
|---|---|
| Unique mobile users | 9 |
| Daily active mobile users | 2–4 |
| Background task fires on an active day | ~1,500 (~400 per device per day) |
| Location sync cadence | batch every 2 min while tracking; heartbeat every 5 min |

### 1.4 Code that exists because of Clerk

- `apps/driver/lib/convex.tsx` — reauth budget, auto-recovery, debounce, `forceReauth`, MAX_AUTO_RECOVERY_ATTEMPTS.
- `apps/driver/lib/hooks/useConnectionRecovery.ts`, loading-gate timeouts in `apps/driver/app/(app)/_layout.tsx`.
- `apps/driver/lib/auth-token-store.ts` — MMKV mirror of the Clerk JWT so background tasks can authenticate without the React tree.
- `apps/driver/lib/sms-otp.ts` + `modules/expo-sms-retriever` — Android zero-tap OTP.
- `apps/driver/app/(auth)/sign-in.tsx`, `verify.tsx`.
- `convex/clerkSync.ts` (13 handlers, retry schedule 30s/5m/30m), `convex/clerkSyncScheduler.ts`, `convex/clerkSyncHelpers.ts`; call sites in `drivers.ts`, `carrierMobile.ts`, `carrierPartnerships.ts`, `maintenance.ts`, `platform/support.ts` (Clerk resync tool).
- `clerkUserId` referenced in 21 Convex files; `identity.subject` in 29 places; `userName` from identity used in ~424 places for audit attribution.
- Phone number is the identity join key: `by_phone` lookups in `carrierMobile.ts`, `normalizePhoneForMatch` in `convex/_helpers/mobileAuth.ts`.

### 1.5 Things that don't exist yet and this plan needs

- No SMS sending capability (Clerk sends the OTP today). No Twilio anywhere in Convex.
- No Universal Links / App Links. The driver app has only the `otoqa-driver` custom scheme (`apps/driver/app.json`); dispatch has `otoqa-dispatch`. Custom schemes are not tappable in iOS Messages.
- No authoritative membership data in Convex and no WorkOS webhooks. `orgMembers` exists but is a display-name directory synced on web login (no role, permissions, or status); carrier-side roles live in `userIdentityLinks` keyed by Clerk user id. Roles and permissions for members reach Convex only inside WorkOS tokens.
- `convex/lib/permissions.ts` `isPermitted`: a token with **no** `permissions` claim is treated as pre-RBAC and granted full access. A new issuer that omits the claim gets admin.

---

## 2. Goals and non-goals

**Goals**
1. One tap to sign in after enrollment. No OTP entry, no waiting on SMS, no repeat sign-ins.
2. Remove the remote-token-minter failure class and the recovery machinery built around it.
3. Admin-controlled enrollment and revocation with a visible device list.
4. Background tasks can always read a valid credential, including while the device is locked.
5. No third party on the mobile critical path once a device is enrolled.
6. One implementation shared by both mobile apps (`packages/mobile-core`).

**Non-goals**
- Changing web or staff-console auth. WorkOS stays.
- Shared-device / per-shift PIN model. Trucks are shared; **mobile devices are not** (product owner, 2026-09-10).
- Building a general-purpose IdP. This is a device-enrollment credential for two first-party apps.

---

## 3. Decisions log (settled 2026-09-10)

| # | Decision | Rationale |
|---|---|---|
| D1 | Mobile only. Web and staff console stay on WorkOS. | WorkOS does membership, invitations, roles, RBAC claims, SSO. SSO is a feature customers buy. Browsers have no keychain. |
| D2 | Both mobile apps move to the new system: Driver **and** Dispatch. | Dispatch's WorkOS flow was never device-validated; unify rather than finish two systems. |
| D3 | Enrollment channels: **SMS (Twilio)** for drivers and carriers/owner-operators; **QR code** for org members (dispatcher role/permissions) who are logged in on the web. Carrier owners with web access also use QR. | Members already have an authenticated web session — no admin, no SMS, no waiting. Drivers have no web session. |
| D4 | Both channels deliver the same one-time enrollment token to the same exchange endpoint. A **code-entry** screen accepts the same token typed by hand. | One exchange implementation; channels are thin wrappers; code entry doubles as the store-review path and the install-hop fallback. |
| D5 | Long-lived device credential. No session timeout. Sign-out is deliberate and harder than today. | Threat model is lost/stolen device and terminated staff, handled by revocation, not expiry. |
| D6 | Server-side revocation check on every authenticated request (session id in JWT → `deviceSessions` lookup in the shared auth helpers). | Makes token lifetime irrelevant to security, which allows a long access token. |
| D7 | Access token lifetime **12 hours**; refresh token rotated on use with a **replay grace window**. | 24× fewer refreshes than 1h; grace window prevents the rotation lockout race. |
| D8 | Local token cache; only call the server near expiry or on a rejected token. Never trust the device clock alone. | Convex re-asks for a token on every websocket reconnect; mobile reconnects constantly. |
| D9 | Mobile access management (device list, send link, QR, revoke, last sync, resync replacement) lives on a **dedicated Settings page**, not on the driver profile. | Product owner decision. |
| D10 | Existing signed-in devices migrate **silently**: a Clerk-authenticated mutation issues the new device credential in the background. No re-enrollment wave. | Zero support load; both providers coexist in `auth.config.ts` during the window. |
| D11 | Identity is the **driver record / member identity**, not the phone number. | Phone changes and shared numbers must not move access. |
| D12 | Authorize mobile **member** requests from mirrored membership data in Convex once the mirror exists; until then, refresh-time WorkOS membership check with bounded grace. | Permission freshness on a 12h token; see OQ-1. |
| D13 | Clerk sign-in tokens (ticket strategy) considered and **rejected** as the destination; acceptable only as a UX spike. | Gets tap-to-sign-in in days but keeps every reliability problem and the vendor on the critical path. |
| D14 | Convex Auth (`@convex-dev/auth`) gets a **spike** before hand-rolling the issuer. | First-party, magic links + refresh rotation inside the deployment, Expo integration. Beta; must verify background-task token access and revocation fit. |
| D15 | Optional biometric gate on owner-mode pay screens. | Answers the "no MFA?" questionnaire question; ~1 day. |

---

## 4. Open questions (answer before schema work)

| # | Question | Options / notes |
|---|---|---|
| OQ-1 | **Membership source of truth in Convex for members.** | A partial mirror already exists: `orgMembers` (WorkOS member directory, synced on web login in `app/callback/route.ts`, used for display-name resolution in 7 files). Carrier-side membership lives in `userIdentityLinks` (role OWNER/ADMIN/MEMBER, keyed by Clerk user id). (a) Evolve `orgMembers` into the single membership table for both org kinds (§5.3) and make it authoritative via WorkOS webhooks. (b) Until webhooks land, at refresh call `workos.userManagement.listOrganizationMemberships` (already used in ~20 places), one call per device per 12h; if WorkOS is down, reissue on last-known claims for a bounded grace (e.g. 48h). Recommendation: the table evolution is **in scope** (it's forced by `clerkUserId` going away); webhooks are the follow-on; ship (b) in between. |
| OQ-2 | **One person, two roles.** A carrier owner who also drives (owner mode today). One session carrying both kinds, or two sessions? | Recommendation: one credential per *person + org*, `kind` claim carries a set (`["driver","member"]`). The dispatch-app split plan (D1/D5 there) removes owner mode from the Driver app after a migration window, which simplifies this. |
| OQ-3 | **Drivers who work for more than one carrier** (via `carrierPartnerships`). One credential per driver-and-org pair, or one per person with an org picker? | Recommendation: per driver-and-org pair; the app only ever shows one org. Verify how many such drivers exist before deciding. |
| OQ-4 | **Who may send SMS enrollment links.** Carrier admins only; or also dispatchers in the web app; or platform support staff. | Recommendation: anyone holding the new `mobile_access:manage` permission, plus platform support (audited). |
| OQ-5 | **Self-service fallback for drivers.** Driver types their phone in the app; link is sent only if it matches an *active* driver record. | This is "OTP once per device". Reduces the admin support desk at fleet scale. Recommendation: yes, rate-limited, off by default per org until the fleet is large. |
| OQ-6 | **Devices per principal.** One active device by default, with admin override? | Recommendation: one by default; enrolling a new device revokes the previous one unless the admin allows multiple. |
| OQ-7 | **Cross-border numbers.** Any drivers on Mexican or Canadian numbers? | Check `drivers.phone`. Affects Twilio pricing, sender registration, and the E.164 normalizer (`normalizePhoneToE164` assumes US). |
| OQ-8 | **Signing runtime.** Does the Convex V8 runtime's SubtleCrypto cover ES256/RS256 signing, or does issuance need a Node action? | Verify in the spike. Node actions have cold starts and cost more compute. |
| OQ-9 | **JWKS hosting.** Convex HTTP action vs static file on Vercel. | Either works; Convex caches JWKS. Static on Vercel avoids even the HTTP-action calls. |
| OQ-10 | **Enrollment token TTLs.** SMS 15 min? QR 2 min? | Anyone can photograph a screen; QR must be short. |
| OQ-11 | **Dormancy window** before a session is marked dormant (no refresh for N days). | 90 days proposed. |
| OQ-12 | **Org identifier in the token for carrier-only orgs.** They have no `workosOrgId`; today they're matched by `clerkOrgId`. | Recommendation: `org_id` = `organizations._id` string for carrier-only orgs, matching the existing `assertCallerInCarrierOrg` match set (`clerkOrgId`/`workosOrgId`/`_id`). Do **not** introduce a fourth identifier. Consolidating 57 tables keyed by `workosOrgId` onto `_id` is a separate platform migration, out of scope. |
| OQ-13 | **Replace the shared static key on `POST /v1/mobile/locations`** with the per-device JWT. | **Resolved: yes, in scope (W13, part of the driver-app workstream).** The key is an `EXPO_PUBLIC` var shipped in the binary, and the handler trusts client-supplied `driverId`, `sessionId`, and `organizationId`, so anyone who extracts the key can write pings for any driver in any org. The route reads the bearer token, resolves the caller via the helper's action variant, takes driver and org from the token, verifies the session belongs to that driver in `ingestBatch`, and rate-limits per device. The three client sync paths (websocket, Clerk-token HTTP client, static-key route) collapse to one HTTP path using the headless token accessor. 401 → one refresh and retry; revoked → stop tracking and abandon the queue. Only the driver app sends locations (dispatch has no location dependency); authorization is by `kind` including `driver`, not by app. Transition: accept bearer or key behind the flag, delete the key path after a week of zero key requests. |

---

## 5. Identity and data model

### 5.1 Principals

| Kind | Who | Enrollment channel | Identity anchor |
|---|---|---|---|
| `driver` | Company drivers, carrier drivers | SMS | `drivers._id` (+ org) |
| `member` | In-house dispatchers, org admins, carrier owners with web access | QR (self-enroll from web session) | WorkOS user id + org id |

`identity.subject` in the new token is `drivers._id` for drivers and the WorkOS user id for members, disambiguated by the `kind` claim. **No new "principals" table** — it would be a join on every request for nothing. Never the phone number, never the Clerk user id.

### 5.2 Design rules for the new tables

These come from the review in §23 and from precedents already in the codebase (`driverSessions.getSessionFreshness` is polled one-shot "so GPS ping writes don't cascade reactive invalidations across the dashboard"; `carrierMobile` comments on "reactive invalidation storms").

1. **The document read on every authenticated request is written only on revoke.** In Convex, every query that reads a document subscribes to it. If the auth helper reads a session doc, then any write to that doc re-runs every live query subscription for that device. So the doc the helper reads must contain nothing that changes on refresh, on request, or on heartbeat. Rotation state, last-seen, last-refresh all live elsewhere.
2. **`sid` is the session document's Convex id.** The helper does `ctx.db.get(normalizeId(sid))`, one primary-key read, no index scan. Invalid or foreign ids fail closed.
3. **Nothing auth-related is added to `drivers`.** It's the hot, PII-bearing table read across the platform. The existing `clerkUserId`/`clerkSync*` fields come off it (§16).
4. **No duplicate of existing state.** Push tokens already live on `driverSessions` (`pushToken`, `pushTokenPlatform`, `by_push_token`, server-authoritative). Do not add `pushToken` to `devices`. Moving push registration from "per shift" to "per device" is a sensible later consolidation, tracked in §23, not part of this plan.
5. **Org references follow the existing convention.** 57 tables key by the WorkOS org id string, 4 by `v.id('organizations')`. New tables carry **both** `organizationId: v.id('organizations')` (for joins) and `orgKey: string` (the same value the token's `org_id` carries, see OQ-12) so org-scoped indexes work for carrier-only orgs too. Do not invent a new identifier.
6. **Small tables, narrow indexes, one purpose each.** Per-org device lists are tens of rows; per-token lookups are single-row by hash.
7. **Every field that will be dropped later is optional from day one**, and every drop is a numbered migration in `convex/migrations/` that unsets the field before the schema change (Convex validates schema on deploy).

### 5.3 New tables (Convex)

```
devices                                  // one row per enrolled install; written on enroll, revoke, dormancy, throttled last-seen
  principalKind: 'driver' | 'member'
  driverId?: Id<'drivers'>
  workosUserId?: string
  organizationId: Id<'organizations'>
  orgKey: string                          // == token org_id (workosOrgId, or organizations._id for carrier-only orgs)
  platform: 'ios' | 'android'
  deviceName: string
  appId: 'driver' | 'dispatch'
  appVersion, osVersion
  installId: string                       // per-install random id; regenerated on reinstall
  enrolledAt, enrolledVia: 'sms' | 'qr' | 'code' | 'clerk_migration'
  lastSeenAt?: number                     // written at most once/hour by a throttled client mutation, never from the auth helper
  status: 'active' | 'revoked' | 'dormant'
  revokedAt?, revokedBy?, revokedReason?
  .index('by_driver', ['driverId'])
  .index('by_workos_user', ['workosUserId'])
  .index('by_orgkey_status', ['orgKey', 'status'])       // settings page + revoke-all
  .index('by_status_lastseen', ['status', 'lastSeenAt'])  // dormancy sweep

deviceSessions                           // THE doc the auth helper reads. Written ONLY on create and revoke.
  deviceId: Id<'devices'>
  principalKind, driverId?, workosUserId?, organizationId, orgKey   // denormalized so the helper needs no second read
  status: 'active' | 'revoked'
  revokedAt?, revokedReason?: 'admin' | 'sign_out' | 'driver_deactivated' | 'member_removed' | 'device_replaced' | 'dormant'
  .index('by_device', ['deviceId'])
  // no by_session_id: sid IS the _id

deviceRefreshTokens                      // rotation state; read only by the refresh action, never by queries
  sessionId: Id<'deviceSessions'>
  tokenHash: string                       // sha-256; raw never stored
  status: 'active' | 'superseded'
  supersededAt?: number                   // replay grace: a superseded token is accepted for GRACE_MS after this and returns the same successor pair
  successorId?: Id<'deviceRefreshTokens'>
  expiresAt
  .index('by_hash', ['tokenHash'])
  .index('by_session', ['sessionId'])
  .index('by_status_expires', ['status', 'expiresAt'])   // cleanup

enrollmentTokens                         // single-use; read by exchange (by hash) and by the settings page (by org)
  tokenHash: string
  principalKind, driverId?, workosUserId?, organizationId, orgKey
  channel: 'sms' | 'qr' | 'code' | 'clerk_migration'
  createdBy: string
  expiresAt
  usedAt?, usedByDeviceId?
  deliveryStatus?: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'opted_out'   // Twilio status callback
  twilioMessageSid?
  .index('by_hash', ['tokenHash'])
  .index('by_orgkey_created', ['orgKey', 'expiresAt'])
  .index('by_expires', ['expiresAt'])                     // cleanup
```

### 5.4 Existing tables: evolve, don't fork

- **`orgMembers` becomes the single membership table** for both org kinds (today: WorkOS directory synced on web login, keyed by WorkOS org id string, used for display names). Add: `organizationRef: v.id('organizations')`, `orgKey`, `principalKind`, `driverId?`, `role`, `permissions?: string[]`, `status: 'active' | 'inactive'`, `source: 'workos' | 'local'`, `syncedAt`. Make the existing `organizationId` (WorkOS string) optional. Indexes: `by_driver`, `by_orgkey_status`, keep `by_org_user`. Carrier owners/admins/members migrate in from `userIdentityLinks` with `source: 'local'`. Display-name consumers (7 files) are unaffected.
- **`userIdentityLinks` is retired**, not extended. Its two jobs — map an external auth id to an org, and hold carrier-side roles — are covered by the token (`sub`, `org_id`, `kind`) and by `orgMembers`. Extending it with a new key would leave two membership tables forever. 22 files reference it; they collapse onto one `orgMembers` lookup. `getUserRoles` Methods 1/2/3 (link by Clerk id, phone fallback, partnership fallback) become one indexed read.
- **`organizations.clerkOrgId`** (68 references) is dropped after decommission; carrier-only orgs are identified by `_id`. `orgType` comments ("Mobile only (Clerk)") updated.
- **`drivers`**: `clerkUserId`, `clerkSyncStatus`, `clerkSyncError`, `clerkSyncAttempts` — optional already; drop via migration after decommission.
- **`driverSessions.pushToken`** unchanged.

---

## 6. Token design

### 6.1 Claims

```
iss:  https://<otoqa-issuer>            (distinct from every WorkOS issuer; staff guard rejects by construction)
aud:  convex
sub:  <otoqa principal id>
sid:  <deviceSessions.sessionId>
kind: ["driver"] | ["member"] | ["driver","member"]   (OQ-2)
org_id: <workosOrgId>                    (present on BOTH kinds; today "no org claim" == driver — that heuristic must go)
organizationId: <convex org id>
name, email, phone
role, permissions[]                      (members; ALWAYS present, possibly empty — see §9)
app: "driver" | "dispatch"
iat, exp (12h), nbf
```

### 6.2 Signing and validation

- Algorithm ES256 (or RS256 if SubtleCrypto forces it — OQ-8). Library: `jose` (already in the lockfile via WorkOS).
- Private key in a Convex env var; public keys published as a JWKS with `kid`. Rotation procedure documented: add new key to JWKS → start signing with it → keep old key in JWKS for max access-token lifetime + 1h → remove.
- `convex/auth.config.ts` gets one more `customJwt` provider: `{ issuer, algorithm, jwks, applicationID: 'convex' }`. The Clerk provider stays until decommission.

### 6.3 Refresh flow

1. Client holds `accessToken` (memory + readable storage) and `refreshToken` (keychain).
2. Convex `setAuth` token callback: return cached access token unless within N minutes of `exp` or `forceRefreshToken` is set **and** the last refresh was more than a few seconds ago (debounce).
3. `POST refresh` (Convex action): look up `deviceRefreshTokens.by_hash`. `active` → proceed. `superseded` within `GRACE_MS` of `supersededAt` → return the successor's pair again (network-retry replay). Anything else → `session_unknown`. Then `ctx.db.get(sessionId)`; `status !== 'active'` → `session_revoked`.
4. Rotate: insert the successor token, mark the old one `superseded` with `supersededAt` and `successorId`. **Nothing on `deviceSessions` is written.** `devices.lastSeenAt` is not touched here either; the client's throttled heartbeat mutation owns it.
5. Members (D12/OQ-1): re-read role/permissions at refresh (WorkOS call or mirror); if the membership is gone → revoke session, return `member_removed`.
6. Response codes drive the app UI (§11.4): `ok`, `session_revoked`, `member_removed`, `device_dormant`, `server_unreachable` (client-side).

### 6.4 Storage on device

| Item | Where | Accessibility |
|---|---|---|
| Refresh token | Keychain / Keystore via `expo-secure-store` | `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (no iCloud Keychain sync, no backup migration) |
| Access token | memory + MMKV (encrypted instance already exists for the ping queue) | readable from background tasks and headless JS |
| Install id | MMKV | regenerated on reinstall |

Persistence facts: iOS keychain items usually survive app deletion; Android Keystore does **not** survive uninstall. Re-enrollment after reinstall is a first-class path, not an edge case. iOS reinstall should silently resume (keychain still holds the refresh token; server still has the session).

### 6.5 Revocation

- `requireCallerIdentity` / `getCallerOrgId` / `assertCallerInCarrierOrg` read `sid`, `normalizeId('deviceSessions', sid)` (fail closed on garbage), `ctx.db.get`, `status !== 'active'` → `ConvexError('SessionRevoked')`. One primary-key read. Because that doc is written only on create and revoke, every query subscription for a device carries one extra dependency that changes at most once in the device's life. Reactive cost: zero in steady state.
- **Actions** have no `ctx.db`; the helper's action variant does `ctx.runQuery(internal.deviceAuth.sessionStatus, { sid })`. Grep shows no public actions call `getUserIdentity` today, so this is a guard for the future, not a migration.
- The location ingest route (`/v1/mobile/locations`) uses a shared static key today and does not go through the helper; OQ-13 tracks moving it to the device JWT.
- Triggers: admin revoke on the settings page; driver deactivated/deleted → revoke all that driver's sessions (replaces `scheduleDeleteClerkUser`); member removed/deactivated in WorkOS → revoke (webhook, or caught at next refresh under OQ-1b); enrolling a new device when one-device policy applies (OQ-6); explicit sign-out.

---

## 7. Enrollment

### 7.1 Common exchange

`POST /enroll` (HTTP action or public action): `{ token, platform, deviceName, installId, appId, appVersion, osVersion, pushToken? }`
→ verify `tokenHash`, not used, not expired → create `devices` + `deviceSessions` → mark token used → return `{ accessToken, refreshToken, principal summary }`.
Single use. Bound to the first device that redeems it. Rate limited per token hash and per IP with `@convex-dev/rate-limiter` (already installed).

### 7.2 SMS (drivers, carriers)

- Sender: Twilio. Message: `<Org name>: tap to set up your Otoqa Driver app <https://<short-domain>/e/<token>>`. Own short domain, **not** a public shortener (carrier filtering).
- Link is an **https Universal Link / App Link** (§13). If the app is installed it opens directly into the exchange. If not, the landing page sends to the store and shows the code to type after install (§7.4).
- TTL 15 min (OQ-10). One outstanding token per driver; sending again invalidates the previous.
- Delivery status via Twilio status callback webhook → `enrollmentTokens.deliveryStatus`, shown live on the settings page.
- Twilio prerequisites (calendar time — start immediately): A2P **10DLC brand + campaign registration**; STOP/HELP handling (a driver who texted STOP cannot receive a link until they opt back in — the settings page must show this); message templates per language (`apps/driver/lib/i18n.ts` exists); international numbers (OQ-7).

### 7.3 QR (members)

- On the settings page, a logged-in member clicks "Add this phone". Server mints an enrollment token **for the current user only** (never for someone else), TTL ~2 min (OQ-10), rendered as a QR encoding the same https link.
- Member scans with the phone camera → Universal Link → app opens → exchange. Alternatively the app has a "Scan QR" button (`expo-camera` is already a dependency of the driver app).
- Convex reactivity: the page shows the device appear the moment it enrolls, with a "This wasn't me — revoke" button.
- Claims at enrollment are copied from the member's live WorkOS session (org, role, permissions, name, email). No WorkOS API call needed.

### 7.4 Code entry (fallback, store review, install hop)

- The same token, rendered as a short human-typable code (e.g. 8 chars, base32, no ambiguous glyphs). Shown on the landing page and, for admins, on the settings page next to the link.
- Solves: link lost across the App Store install hop; iOS Messages quirks; Apple review (reviewer gets a code); Android unverified App Links.

### 7.5 Dev / staging

- No Twilio in dev: print the link/code in the Convex log and on the admin page. Feature flag `mobileAuth.sendSms`.
- Per-environment link domains (AASA/assetlinks are per domain).

---

## 8. Lifecycle and recovery flows

| Situation | Behavior |
|---|---|
| Normal use | Access token from cache; refresh every ~12h while the app is alive; background tasks read the access token directly. |
| Offline for days | Expired access token must **not** block local features (offline queue, pending actions, location capture). Refresh on reconnect; only a rejected refresh changes auth state. |
| Reinstall on iOS | Keychain still holds the refresh token → silent resume. |
| Reinstall on Android / new device | "Contact your admin" screen with the admin's name and a one-tap "request a link" that pings the dispatcher (push/email), plus code entry. Self-service phone entry if OQ-5 is on. |
| Device transfer | Not automatic (this-device-only keychain). New device enrolls; old one revoked per OQ-6. |
| Admin revoke / driver deactivated | Next request fails with `SessionRevoked` → app clears local state, shows "Access removed. Contact <admin>". |
| Member removed on the web | Same, via webhook or at next refresh (OQ-1). |
| Sign out | Deliberate: confirmation dialog, then `performSignOut` sequence (push token, ping queue, motion service, yard fences), then revoke the session server-side. Harder than today by design (D5). |
| Dormant | No refresh for N days (OQ-11) → status `dormant`, shown as such in the device list; a later refresh from that session is rejected and the device must re-enroll. |
| Cleanup cron | Daily: delete used/expired `enrollmentTokens`; delete `deviceSessions` past `previousValidUntil` + refresh expiry; mark dormant devices. Housekeeping only — security does not depend on it. |

---

## 9. Authorization changes (must land before the new issuer exists)

1. **Scope the legacy permission rule.** `isPermitted` grants full access when `permissions == null`. Restrict that grandfathering to tokens from the WorkOS issuers, or make the new issuer always emit `permissions` (empty array for drivers) **and** change the rule to treat `null` as denied for `kind` tokens. Do both.
2. **Replace the "no org claim == driver" heuristic.** `getCallerOrgId` returning null currently means "driver app caller". The new token carries `org_id` for both kinds; callers must branch on `kind`. Audit every `getCallerOrgId` consumer and the dual-path helpers (`assertCallerInCarrierOrg`, `requireCarrierAuth`, `getUserRoles` Methods 1+2 phone fallback).
3. **Staff guard.** `requirePlatformStaff` compares issuer strings; the new issuer must never equal `STAFF_ISSUER`. Add a test.
4. **Audit attribution.** `name`, `email` claims must be present; ~424 `userName` uses depend on it.
5. **Member authorization source.** Per D12/OQ-1: claims at first, DB later. Wrap in one helper so the switch is a one-line change.
6. **Phone fallback lookups** (`by_phone`, `normalizePhoneForMatch`) become migration-only and are removed at decommission. The `drivers.by_phone` index stays (import/dedupe use it); only its auth use goes.
7. **One caller helper, enforced by lint.** All 29 `identity.subject` reads and every `ctx.auth.getUserIdentity()` outside `convex/lib/auth.ts` route through `resolveCaller(ctx)` returning `{ kind, subject, driverId?, workosUserId?, orgKey, organizationId, sessionId, name, email, role?, permissions? }`. Add an ESLint `no-restricted-syntax` rule (the config already uses `no-restricted-imports`) that forbids `ctx.auth.getUserIdentity` and `identity.subject` outside that file. This is what stops a second dual-path helper family from growing.
8. **All Clerk-compat code lives in one folder** (`convex/legacy/clerk/`: the migration mutation, the Clerk-shape token adapter, the phone fallbacks) so decommission is a folder delete plus one provider line in `auth.config.ts`. Today's dual-path helpers with phone fallback became permanent because nothing fenced them.

---

## 10. Web app

### 10.1 Settings → Mobile access (new page, D9)

- Tabs or sections: **Drivers** and **Team members**.
- Per row: name, devices (platform, device name, app + version, enrolled via, last seen, last refresh, status), delivery status of the last link, STOP/opt-out flag, actions: **Send link (SMS)**, **Show code**, **Revoke device**, **Revoke all**.
- **Add this phone** (QR) for the current member.
- Replaces the Clerk "resync" / "last sync status" affordances wherever they live today (driver profile, platform console).
- New RBAC area in `lib/team-rbac.ts`: `mobile_access` (view / manage). Admin bypass applies as usual.
- Audit log entries via existing `auditLog` for send, enroll, revoke.

### 10.2 Team page

- Link to the member's devices on the Mobile access page. Deactivating a member triggers revocation (directly if the mirror exists, otherwise the next refresh catches it).

### 10.3 Platform console (`apps/admin`)

- Replace `resyncDriverClerk` and the Clerk fields in `platform/support.ts` with: list devices for an org/driver, send link on behalf (audited, reason required), revoke, view enrollment token delivery status.

### 10.4 WorkOS webhooks (OQ-1a, follow-on)

- New authenticated route in `convex/http.ts` with signature verification; events: membership created/updated/deleted/deactivated, role changes. Backfill job from `listOrganizationMemberships`. Drift check cron.

---

## 11. Mobile apps

### 11.1 `packages/mobile-core` — shared auth client (new)

- `enroll(token, deviceInfo)`, `getAccessToken({ forceRefresh })`, `refresh()`, `signOut()`, `onAuthStateChange`.
- Token cache + near-expiry refresh + debounce; storage per §6.4; response-code → state mapping (§11.4).
- A `ConvexProviderWithDeviceAuth` wrapper exposing `useAuth`-compatible `{ isLoading, isAuthenticated, fetchAccessToken }` for `ConvexProviderWithAuth`.
- Headless entry (`getAccessTokenHeadless()`) for background tasks and `fcm-handler.ts`.

### 11.2 Driver app

Remove: `ClerkProvider`, `tokenCache`, `@clerk/clerk-expo`, `auth-token-store.ts`, the recovery state machine in `convex.tsx`, `useConnectionRecovery` auth paths, loading-gate reauth paths, `sms-otp.ts` + `modules/expo-sms-retriever`, `(auth)/sign-in.tsx`, `(auth)/verify.tsx`.
Add: `(auth)/enroll.tsx` (handles link/QR/code), `(auth)/code-entry.tsx`, `(auth)/contact-admin.tsx`, `(auth)/access-removed.tsx`, "Scan QR" (reuse `expo-camera`).
Keep: `performSignOut` sequencing (swap the Clerk `signOut` for the session revoke), `useBootstrap`, role switch until the dispatch split removes owner mode.

### 11.3 Dispatch app

Remove: Clerk, the WorkOS PKCE scaffold (`lib/auth/workos-token-source.ts`), `expo-auth-session`/`expo-web-browser` if unused elsewhere.
Add: the same enrollment screens from mobile-core; members enroll by QR, owner-operators by SMS.

### 11.4 App auth states

| State | Trigger | Screen |
|---|---|---|
| `unenrolled` | no refresh token | Enroll: "Open the link we sent you" + code entry + Scan QR + "I don't have a link" → contact admin / self-service (OQ-5) |
| `authenticated` | valid session | app |
| `offline_stale` | expired access token, refresh unreachable | app, offline indicator (existing `OfflineIndicator`); no auth gate |
| `revoked` | `session_revoked` / `member_removed` | Access removed, admin name, request link |
| `dormant` | `device_dormant` | same as revoked with different copy |

### 11.5 Native build requirements

- Associated domains entitlement (iOS) and App Links intent filters with `autoVerify` (Android) — **cannot ship OTA**; new EAS build through store review for both apps.
- `apple-app-site-association` and `assetlinks.json` served on the link domain(s), per environment.

---

## 12. Twilio checklist

- Account, messaging service, **10DLC brand + campaign** (lead time: days to weeks). Start week 1.
- Own short link domain with verified AASA/assetlinks; never a public shortener.
- STOP/HELP webhooks → `optedOut` flag on the driver; settings page shows it and blocks sending.
- Status callback webhook → `enrollmentTokens.deliveryStatus`.
- Templates (EN/ES per existing i18n), org name in body, no PII beyond first name.
- Rate limits: per driver (e.g. 3/hour), per org (e.g. 100/day), per sender.
- International (OQ-7).
- Cost: per-segment SMS at enrollment only, not per login.

---

## 13. Deep links

- Domains: e.g. `go.otoqa.com` (prod), `go-staging.otoqa.com`. Serve AASA (`/.well-known/apple-app-site-association`, paths `/e/*`) and `assetlinks.json` with both apps' identifiers.
- Landing page at `/e/<token>`: detects platform; if the app opens, nothing else happens; otherwise store badge + the typable code + "already installed? open the app and tap Enter code".
- Deferred deep link across the install hop is unreliable; the typable code is the guaranteed path.
- Android: unverified App Links can be claimed by other apps → verification must pass before launch.

---

## 14. Migration and rollout

1. **Flag**: `mobileAuth.deviceCredentials` (feature flag infra exists: `convex/featureFlags.ts`, `apps/driver/lib/feature-flags.ts`). Per org, then global.
2. **Dual providers** in `auth.config.ts`: Clerk + new issuer both accepted. All auth helpers accept both token shapes for the window.
3. **Silent upgrade (D10)**: on app start, if signed in via Clerk and flag on → call `migrateFromClerk` (authenticated by the Clerk token) → server resolves the driver/owner via `userIdentityLinks` → issues device credential, `enrolledVia: 'clerk_migration'` → app switches token source → Clerk session left to expire. PostHog `$alias` old Clerk id → new subject so history isn't split.
4. **New enrollments** go straight to the new system once the flag is on for the org.
5. **Cutover**: when no active Clerk tokens have been seen for N days (telemetry), remove the Clerk provider.
6. **Decommission** (§16).

Rollback: flag off → new enrollments stop; existing device credentials keep working (issuer stays); Clerk path still present until step 5.

---

## 15. Security controls and threat comparison

| Risk | Today (Clerk OTP + long session) | Proposed | Delta / control |
|---|---|---|---|
| Lost or stolen unlocked phone | session persists | credential persists | Same. Device passcode + admin revoke. Optional biometric gate on pay screens (D15). |
| SIM swap / SMS interception | every login exposed | enrollment only | Better. |
| Driver forwards the link | n/a | possible | Single-use, short TTL, app-only link, bind to first device, admin notified on new device, one device per principal (OQ-6). |
| Admin sends link to wrong number | wrong person gets OTP | wrong person enrolls | Same. Link landing shows the driver's first name; admin sees the enrolled device immediately. |
| Terminated driver keeps access | only if nobody deletes them | only if nobody deactivates them | Same; revocation is tied to deactivation. |
| Phone reassigned without wipe | old session persists | credential persists | Same; "Not you? Sign out" on the enroll screen; one-device policy revokes on the new enrollment. |
| QR photographed off a screen | n/a | possible | 2-min TTL, self-only minting, live "this wasn't me" revoke. |
| Bugs in our crypto / rotation | Clerk's problem | ours | Standard `jose`, standard rotation with grace, tests for replay/race/expiry; or Convex Auth (D14). |
| Public sign-in endpoint abuse | exists | none | Better. |
| Permission escalation via missing claim | n/a | `isPermitted` legacy rule | §9.1 lands first. |
| Signing key compromise | n/a | ours | Env-var custody, `kid` rotation runbook, revoke-all-sessions tool. |

Data at stake per compromised driver credential: that driver's own PII (SSN, license, DOB on `drivers`), their loads, and in owner mode their pay. Scope per credential is unchanged from today.

Questionnaire answer: "Device-bound credential established through admin-controlled enrollment, server-side revocation on every request, full audit trail, optional biometric step-up." Not "no MFA".

---

## 16. Decommission checklist

- `convex/clerkSync.ts`, `clerkSyncScheduler.ts`, `clerkSyncHelpers.ts`, all `scheduleXxxClerkUser` call sites, `platform/support.ts` Clerk tools, `maintenance.ts` `syncExistingCarrierOwnersToClerk`.
- Clerk provider in `auth.config.ts`; `CLERK_*` env vars; Clerk SMS template with the SMS-retriever hash.
- `@clerk/clerk-expo` in both apps; `expo-sms-retriever` module; `sms-otp.ts`; `auth-token-store.ts`; recovery machine; `(auth)/sign-in.tsx`, `verify.tsx`.
- `clerkUserId` + `clerkSync*` on `drivers`; the whole `userIdentityLinks` table (after backfill into `orgMembers`); `organizations.clerkOrgId` (68 refs) and the Clerk wording on `orgType`; phone-fallback auth lookups. Each is a numbered migration in `convex/migrations/` that unsets fields before the schema drop.
- `convex/legacy/clerk/` folder; `CLERK_ISSUER_URL` provider block in `auth.config.ts`.
- `apps/dispatch/package.json` Clerk dependency (already unused), `expo-auth-session` + `expo-web-browser` (only used by the WorkOS scaffold), `@clerk/clerk-expo` in the driver app.
- `apps/driver/app/_layout.tsx` `tokenCache` + the keychain-accessibility comment block; `docs/security-review.md` §Auth and the `clerkSync` log-PII findings; `docs/dispatch-app-split-plan.md` D4/D5.
- PostHog events: `sign_in_*`, `verification_*`, `convex_auth_*` recovery events → replaced by `enroll_*`, `device_auth_*`.
- `MOBILE_LOCATION_API_KEY` once OQ-13/W13 ships.

---

## 17. Cost (Convex)

Not verified against the pricing page (network egress blocked during the discussion); confirm before relying on it. Pro plan from memory: 25M function calls, 250 GB-h action compute, 50 GB DB bandwidth included per month.

| Operation | Convex calls | Cadence |
|---|---|---|
| Refresh (validate, rotate, sign) | ~3 | once per 12h per live device |
| Revocation read | 0 extra calls, 1 small doc read | every authenticated request |
| JWKS fetch | a handful/day, cached | rare |
| Enrollment | ~2 + Twilio | once per device |
| Cleanup cron | 1 | daily |

| Enrolled active devices | Auth calls / month (12h token) |
|---|---|
| 10 | ~2,000 |
| 500 | ~90,000 |
| 5,000 | ~900,000 |

Auth stays under 10% of existing mobile traffic (~400 background fires/device/day plus a location batch every 2 min). Clerk at 9 MAU is almost certainly free tier, so cost is not the argument; reliability and UX are.

---

## 18. Store review

- Apple needs a way in: reviewer enrollment code via code entry (§7.4). Put it in App Review notes.
- Account deletion guideline likely doesn't apply (accounts are admin-created), but have the answer ready; "Sign out" + admin-side deletion path documented.
- Associated domains + new entitlements → full review, not OTA.

---

## 19. Telemetry

- `enroll_started` (channel), `enroll_succeeded`, `enroll_failed` (reason), `device_auth_refresh` (ok/code, elapsed), `device_auth_revoked_seen`, `device_auth_offline_stale`, `clerk_migration_succeeded/failed`.
- Settings page reads `lastSeenAt`/`lastRefreshAt` (replaces "last sync status").
- Alert: refresh failure rate per app version; enrollment SMS undelivered rate.

---

## 20. Testing

- Unit (convex-test): exchange (single-use, expiry, wrong org), refresh rotation incl. replay within/after grace, revocation on every helper, `isPermitted` with/without claims per issuer, staff guard rejects new issuer, `getCallerOrgId` with `kind` tokens, migration mutation.
- Client: token cache near-expiry logic, debounce, headless token access, state machine transitions.
- Device matrix: iOS locked-device background refresh; Android reinstall → re-enroll; Universal Link cold/warm start; QR scan; code entry; offline for >12h then reconnect; revoke while foregrounded/backgrounded.
- Install with `npm ci` (dual-lockfile hazard noted in the dispatch plan).

---

## 21. Workstreams and sequencing (rough)

Long-lead items start on day 1 regardless of the spike outcome.

| # | Workstream | Depends on | Rough size |
|---|---|---|---|
| W0 | Twilio account, 10DLC registration, short domain, AASA/assetlinks, STOP/HELP + status webhooks | — | 2–3 days of work, **weeks of waiting** |
| W1 | Spike: Convex Auth vs hand-rolled issuer; SubtleCrypto signing in V8; JWKS hosting | — | 2–3 days |
| W2 | Authorization hardening (§9): permissions rule, `kind` claim, staff guard test, helper audit | — | 2–3 days |
| W3 | Schema + issuer: tables, enrollment exchange, refresh/rotation, revocation in helpers, cleanup cron, key rotation runbook | W1, W2 | 4–5 days |
| W4 | `packages/mobile-core` auth client + headless access + state machine | W3 | 3–4 days |
| W5 | Driver app: remove Clerk stack, enrollment screens, background-task token, offline-stale behavior | W4 | 4–5 days |
| W6 | Dispatch app: remove Clerk + WorkOS scaffold, enrollment screens | W4 | 2–3 days |
| W7 | Web: Settings → Mobile access page, QR self-enroll, RBAC area, audit entries, team-page hooks | W3 | 4–5 days |
| W8 | Platform console tools | W3 | 1–2 days |
| W9 | Silent Clerk migration + PostHog alias + flag | W3, W5 | 2 days |
| W10 | Native builds (entitlements), device matrix, store submission | W5, W6, W0 | 3–4 days + review |
| W11 | WorkOS webhooks making `orgMembers` authoritative + DB authorization for members | W3 | 3–4 days, can follow launch |
| W12 | Decommission (§16), including the field-drop migrations and the `userIdentityLinks` retirement | cutover | 3 days |
| W13 | Location ingest on device JWT instead of the shared static key; collapse the three client sync paths (OQ-13) | W4 | 1–2 days, ships with W5 |
| W14 | `orgMembers` evolution + `userIdentityLinks` backfill + `resolveCaller` helper + lint rule | W2 | 3 days (moved out of W3 because it touches 22 + 29 call sites) |

Roughly 3 engineer-weeks of build for the core (W1–W9, W14) plus W0's calendar lead time and store review. W11 and W13 can trail.

---

## 22. Risks

- **Mobile auth is the most sensitive thing to ship.** Mitigation: flag, dual providers, silent migration, device matrix before rollout, rollback path in §14.
- **10DLC approval slips.** Mitigation: QR and code entry work without SMS; email link as an interim channel for drivers with email on file.
- **Universal Link flakiness.** Mitigation: code entry is always available and always works.
- **Refresh rotation lockout.** Mitigation: grace window + tests; admin "send new link" is the backstop.
- **Permission freshness for members** until the mirror exists. Mitigation: refresh-time WorkOS check with bounded grace (OQ-1b); 12h worst case is stated and accepted, or shorten member tokens to 1h until W11 lands.
- **Convex Auth beta surprises.** Mitigation: the spike is time-boxed; the hand-rolled path is fully specified above.

---

## 23. Schema and platform review (v0.2)

Review of the v0.1 draft against the codebase for reactivity, tech debt, and effects on the rest of the platform. Each finding names what changed in the plan.

### 23.1 Reactivity: the v0.1 design would have re-run every mobile query on every refresh

v0.1 put `refreshTokenHash`, `rotatedAt`, and `lastRefreshAt` on the same `deviceSessions` doc the auth helper reads on every request, and `lastSeenAt` on `devices`. In Convex every query that reads a doc subscribes to it; a write re-runs all of those subscriptions. With ~5 subscribed queries per driver screen, one refresh would have re-executed all of them, and a per-request `lastSeenAt` would have been a self-inflicted invalidation storm of the kind the codebase already guards against (`driverSessions.getSessionFreshness` is deliberately polled; `carrierMobile` comments call it out).

Fixed: `deviceSessions` is written only on create and revoke (§5.2 rule 1); rotation state moved to `deviceRefreshTokens`, read only by the refresh action; `lastSeenAt` is a throttled client heartbeat, never touched by the helper; `sid` is the session doc's `_id` so the helper does a primary-key `get`, no index (§6.5).

### 23.2 Two membership tables were about to become three

`userIdentityLinks` (carrier-side roles, keyed by Clerk user id, 22 files) and `orgMembers` (WorkOS directory synced on web login, 7 files) already overlap. v0.1 added `orgMemberships`. Fixed: evolve `orgMembers` into the single membership table with `source: 'workos' | 'local'`, backfill carriers from `userIdentityLinks`, retire `userIdentityLinks` (§5.4). `getUserRoles` Methods 1/2/3 collapse to one indexed read.

### 23.3 Push tokens would have been duplicated

`driverSessions` already holds `pushToken`/`pushTokenPlatform` with a `by_push_token` index and server-authoritative registration (see `docs/runbooks/dispatch-push-credentials.md`). v0.1 added `pushToken` to `devices`. Removed. Consolidating push registration onto `devices` (per install rather than per shift) is a reasonable later change and is **not** part of this plan.

### 23.4 Org identity: three identifiers already, don't add a fourth

Orgs are referenced by `workosOrgId` (57 tables), `v.id('organizations')` (4 tables), and `clerkOrgId` (68 code references, carrier-only orgs). The token's `org_id` follows the existing match set: `workosOrgId` where present, else `organizations._id` (OQ-12). New tables carry both `organizationId` and `orgKey` (§5.2 rule 5). `clerkOrgId` is dropped at decommission. A platform-wide consolidation onto `_id` is real debt but a separate project.

### 23.5 Nothing goes on `drivers`

The hot, PII-bearing table. v0.1 already avoided adding to it; v0.2 makes it a rule and schedules removal of the four Clerk fields it carries today.

### 23.6 Dual-path helpers become permanent unless fenced

The current `assertCallerInCarrierOrg` / `getUserRoles` phone fallbacks were "temporary" and are now load-bearing. Fixed: one `resolveCaller` helper, an ESLint rule forbidding direct `getUserIdentity`/`identity.subject` use outside `convex/lib/auth.ts`, and all Clerk-compat code in `convex/legacy/clerk/` (§9.7–9.8). Decommission is then a folder delete and one provider line.

### 23.7 Schema drops need migrations, not edits

Convex validates the schema on deploy; a field can't be removed while any document carries it. Every drop (`drivers.clerk*`, `userIdentityLinks`, `organizations.clerkOrgId`) is a numbered script in `convex/migrations/` (the pattern already exists, `001`–`009`) that unsets before the schema change (§5.2 rule 7, W12).

### 23.8 Effects on the rest of the platform

| Area | Effect | Handling |
|---|---|---|
| Every authenticated Convex function | one extra primary-key read inside the same transaction | sub-millisecond; doc never changes in steady state |
| Query subscriptions (mobile) | one extra dependency per subscription | changes only on revoke |
| Web auth, staff console | none | `isPermitted` legacy rule must keep WorkOS behavior unchanged (§9.1) |
| Web team page, audit log display names | `orgMembers` gains fields; existing reads unchanged | additive migration |
| Platform console | Clerk resync tools replaced | W8 |
| External tracking API, crons, internal functions | none | — |
| Location ingest route | none until W13 | shared key stays for now |
| Rate limiter component | new buckets for enroll/refresh/send | shared component, isolated keys |
| Audit log volume | + enroll/revoke/send events | low |
| Dispatch split plan | D4/D5 there superseded by D2/D3 here | update that doc at W6 |
| PostHog | subject changes | `$alias` at migration (§14.3) |

### 23.9 Cleanup already owed, surfaced by this review

- `apps/dispatch/package.json` still lists `@clerk/clerk-expo` though `lib/auth` moved to WorkOS.
- `expo-auth-session` and `expo-web-browser` in dispatch are used only by the never-validated WorkOS scaffold.
- `convex/clerkSync.ts` logs driver names and phone numbers (flagged in `docs/security-review.md`); it is deleted rather than fixed.
- `organizations.orgType` comments describe Clerk as the mobile provider.
