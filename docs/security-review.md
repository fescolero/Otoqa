# Security Review — Otoqa Codebase

**Date:** 2026-02-22
**Scope:** Full codebase review covering Convex backend, Next.js web app, and React Native mobile app
**Methodology:** Manual source code review against OWASP Top 10 (2021) and platform-specific threat models

---

## Executive Summary

The Otoqa codebase is a multi-tenant logistics TMS (Transportation Management System) using Convex as its serverless backend, Next.js for the web frontend, and React Native/Expo for the mobile app. Authentication is split between WorkOS (web/admin users) and Clerk (mobile drivers/carrier owners).

The most critical class of vulnerabilities found relates to **Broken Object-Level Authorization (BOLA)** — multiple Convex `query` and `mutation` endpoints accept organization IDs as client-supplied arguments without verifying the caller belongs to that organization. This is the single highest-priority issue.

---

## Findings

### FINDING 1: Broken Object-Level Authorization (BOLA) — Carrier Mobile API

**Severity:** CRITICAL
**Confidence:** HIGH (95%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/carrierMobile.ts`

**Description:**
Nearly every query and mutation in `carrierMobile.ts` accepts `carrierOrgId` (and optionally `carrierConvexId`) as plain string arguments from the client. None of these functions verify that the authenticated caller actually belongs to the organization whose data they are requesting.

Affected functions include:
- `getDashboard` (line 48) — returns active loads, revenue, driver counts for any org
- `getOfferedLoads` (line 178) — lists offered loads for any org
- `getActiveLoads` (line 242) — lists in-progress loads for any org
- `getCompletedLoads` — lists completed loads for any org
- `getLoadDetail` — returns full load details for any org
- `getDrivers` — lists all drivers for any org
- `acceptLoad` / `declineLoad` — mutations that modify load assignments for any org

An authenticated mobile user can pass any organization ID to retrieve or modify another organization's data.

**Remediation:**
Every carrier mobile endpoint should extract the caller's organization from their authentication token (via `ctx.auth.getUserIdentity()`) or cross-reference it against `userIdentityLinks`, rather than trusting a client-supplied `carrierOrgId`. At minimum, add a check that the authenticated user's identity maps to the claimed organization.

---

### FINDING 2: Broken Object-Level Authorization (BOLA) — Drivers API

**Severity:** HIGH
**Confidence:** HIGH (90%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/drivers.ts`

**Description:**
The drivers CRUD API accepts `organizationId` as a client-supplied string without authentication or authorization checks:

- `list` (line 89) — returns all drivers for any organization ID
- `countDriversByStatus` (line 26) — returns driver status counts for any org
- `get` — returns a specific driver's data
- `create` (line 177) — creates a driver in any organization
- `update` / `softDelete` — modifies/deletes drivers

The `create` mutation (line 177) has no call to `ctx.auth.getUserIdentity()` at all. Anyone who can call this mutation can create drivers in any organization.

The `list` query also exposes sensitive data via the `includeSensitive` flag (line 93), which when set to `true` will return SSN, license numbers, and date of birth — with no authorization check on who is requesting it.

**Remediation:**
All driver endpoints must authenticate the caller and verify they belong to the target organization. The `includeSensitive` flag should require explicit authorization (e.g., admin role) rather than being a client-controllable boolean.

---

### FINDING 3: Credential Exposure via Public Query — Integrations API

**Severity:** HIGH
**Confidence:** HIGH (90%)
**OWASP Category:** A01:2021 — Broken Access Control / A02:2021 — Cryptographic Failures
**Files:** `convex/integrations.ts:237-254`

**Description:**
The `getCredentials` function is exported as a public `query` (not `internalQuery`), despite a code comment stating "This should only be called from server-side code":

```typescript
export const getCredentials = query({
  // ...
  handler: async (ctx, args) => {
    // ...
    return integration.credentials; // Returns raw credential JSON
  },
});
```

This means any authenticated client can call `getCredentials` with any `workosOrgId` and `provider` string to retrieve raw integration API keys (e.g., FourKites API keys). There is no authentication check (`ctx.auth.getUserIdentity()` is not called) and no authorization check (the caller's org is not verified).

By contrast, `getIntegrations` and `getIntegrationByProvider` correctly mask credentials with `'***'`.

**Remediation:**
Change `getCredentials` from `query` to `internalQuery` so it cannot be called from client code. If client access is ever needed, add authentication and authorization checks.

---

### FINDING 4: Loose Phone Number Matching Enables Identity Confusion

**Severity:** MEDIUM
**Confidence:** MEDIUM (75%)
**OWASP Category:** A01:2021 — Broken Access Control / A07:2021 — Identification and Authentication Failures
**Files:** `convex/carrierMobile.ts:880-886`, `convex/driverMobile.ts:119-121`

**Description:**
Both `getUserRoles` (carrierMobile.ts) and `getMyProfile` (driverMobile.ts) match driver/owner identity by phone number using `endsWith` comparisons:

```typescript
// carrierMobile.ts:884-886
return linkPhone === normalizedUserPhone ||
       linkPhone.endsWith(normalizedUserPhone) ||
       normalizedUserPhone.endsWith(linkPhone);

// driverMobile.ts:121
return driverPhone === normalizedPhone ||
       driverPhone.endsWith(normalizedPhone) ||
       normalizedPhone.endsWith(driverPhone);
```

The `endsWith` logic means a phone number like `5551234` would match `+15551234`, but also a shorter phone input like `1234` would match any phone ending in `1234`. In multi-tenant environments where different organizations may have drivers with overlapping phone suffixes, this could result in a user being matched to the wrong driver record or identity link, potentially gaining access to another organization's data.

Additionally, `getUserRoles` (line 876-878) scans ALL `userIdentityLinks` documents in the entire database (`.collect()` with no index filter) which is a performance concern as the dataset grows and increases the surface area for false matches.

**Remediation:**
- Require exact phone match after normalization (both sides normalized to E.164 format)
- Remove the `endsWith` fallback logic
- Use an indexed query rather than `.collect()` on the full table

---

### FINDING 5: Missing Authentication on Loads API Queries

**Severity:** MEDIUM
**Confidence:** HIGH (85%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/loads.ts`

**Description:**
The `countLoadsByStatus` query (line 11) accepts `workosOrgId` as a client-supplied string and returns load counts without authenticating the caller. While the data exposed (aggregate counts) is less sensitive than individual records, it still leaks organizational metadata.

Similar patterns exist across other load queries that accept `workosOrgId` without authentication.

**Remediation:**
Add `ctx.auth.getUserIdentity()` checks and verify the caller belongs to the requested organization.

---

### FINDING 6: Missing Cross-Org Authorization in Settings Update

**Severity:** MEDIUM
**Confidence:** MEDIUM (75%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/settings.ts:54-156`

**Description:**
The `updateOrgSettings` mutation authenticates the caller (`ctx.auth.getUserIdentity()`) but does not verify the caller is a member of the organization identified by `args.workosOrgId`. An authenticated user from Organization A could update Organization B's settings (name, billing info, subscription plan, timezone, etc.) or even create a new organization record.

**Remediation:**
Verify the authenticated user's organization membership matches the target `workosOrgId` before allowing updates. This could be done by checking WorkOS organization memberships.

---

### FINDING 7: Missing Authentication on Integration Mutations

**Severity:** MEDIUM
**Confidence:** HIGH (85%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/integrations.ts`

**Description:**
The following mutations have no authentication checks:
- `upsertIntegration` (line 50) — creates/updates integration credentials
- `updateSyncSettings` (line 119) — modifies sync configuration
- `deleteIntegration` (line 187) — deletes integrations
- `updateSyncStats` (line 207) — updates sync statistics

Any caller can create, modify, or delete integrations for any organization by supplying a `workosOrgId`.

**Remediation:**
Add authentication and organization membership checks to all integration mutations.

---

### FINDING 8: Webhook SSRF Incomplete Mitigation

**Severity:** LOW
**Confidence:** MEDIUM (70%)
**OWASP Category:** A10:2021 — Server-Side Request Forgery (SSRF)
**Files:** `convex/externalTrackingWebhooks.ts:42-62`

**Description:**
The webhook subscription creation validates the URL against some private IP patterns:
```typescript
hostname === 'localhost' ||
hostname === '127.0.0.1' ||
hostname.startsWith('10.') ||
hostname.startsWith('192.168.') ||
hostname.match(/^172\.(1[6-9]|2\d|3[01])\./)
```

However, this check has gaps:
- Does not block `0.0.0.0`, `[::1]`, or other IPv6 loopback addresses
- Does not block `169.254.x.x` (link-local), `100.64.x.x` (CGNAT), or cloud metadata IPs like `169.254.169.254`
- DNS rebinding attacks could bypass hostname checks (hostname resolves to a public IP at check time, then changes to internal IP at delivery time)
- Does not block `http://` URLs that redirect to internal services

The HTTPS requirement (`args.url.startsWith('https://')`) provides some defense since most internal services don't present valid TLS certificates.

**Remediation:**
- Block additional private/reserved ranges: `0.0.0.0`, `[::1]`, `169.254.x.x`, `100.64.x.x`, `fd00::/8`
- Consider resolving the hostname and checking the IP at delivery time, not just subscription time
- Block cloud metadata endpoints explicitly (e.g., `169.254.169.254`)

---

### FINDING 9: IP Allowlist Check is a No-Op

**Severity:** LOW
**Confidence:** HIGH (95%)
**OWASP Category:** A01:2021 — Broken Access Control
**Files:** `convex/http.ts:109-114`

**Description:**
The external tracking API authentication middleware reads `ipAllowlist` from the API key record but never enforces it:

```typescript
// IP allowlist check
if (keyData.ipAllowlist && keyData.ipAllowlist.length > 0) {
  // In Convex httpAction, we can't reliably get client IP
  // IP allowlisting will be checked when Convex supports forwarded headers
  // For now, this is a no-op but the field is stored for future use
}
```

Users may configure IP allowlists in the UI believing their API keys are restricted to specific IPs, but this restriction is never enforced. This creates a false sense of security.

**Remediation:**
Either remove the IP allowlist feature from the UI until it can be enforced, or clearly communicate to users that IP restrictions are not currently active. Consider using Convex's forwarded headers if available, or a proxy layer that can enforce IP restrictions.

---

### FINDING 10: Rate Limiting Not Enforced

**Severity:** LOW
**Confidence:** HIGH (90%)
**OWASP Category:** A04:2021 — Insecure Design
**Files:** `convex/http.ts:57-62, 117-119`

**Description:**
Rate limit tiers are defined and read from API key records, but there is no actual enforcement mechanism. The `rateLimitPerMin` value is computed and included in the `AuthContext` but never checked against actual request counts. The health check endpoint returns rate limit info to the caller, but no requests are ever denied due to rate limiting.

Without rate limiting, the external tracking API is vulnerable to abuse and potential denial-of-service through excessive API calls.

**Remediation:**
Implement server-side rate limiting, potentially using Convex's mutation-based counter with a sliding window, or an external rate limiting service.

---

### FINDING 11: Excessive Console Logging of Sensitive Data

**Severity:** LOW
**Confidence:** MEDIUM (70%)
**OWASP Category:** A09:2021 — Security Logging and Monitoring Failures
**Files:** Multiple files

**Description:**
Several files log potentially sensitive information to the console:

- `mobile/lib/s3-upload.ts:65` — Logs full file path information: `JSON.stringify(fileInfo)`
- `convex/s3Upload.ts:30-35` — Logs S3 bucket configuration and credential status
- `convex/s3Upload.ts:148` — Logs first 100 chars of presigned URLs (which contain auth signatures)
- `convex/clerkSync.ts:73` — Logs driver names and phone numbers during Clerk sync
- `convex/clerkSync.ts:248` — Logs phone number transitions during updates
- `convex/driverMobile.ts:214` — Logs driver names and org IDs

In Convex, `console.log` output goes to the Convex dashboard logs which are accessible to anyone with dashboard access. The presigned URL fragments could potentially be used to construct upload requests.

**Remediation:**
Remove or reduce console logging of PII (names, phone numbers) and security-sensitive data (presigned URLs, credential status). Use structured logging with appropriate log levels.

---

### FINDING 12: Lack of Input Validation on User-Facing Queries

**Severity:** LOW
**Confidence:** MEDIUM (65%)
**OWASP Category:** A03:2021 — Injection
**Files:** `convex/http.ts:227`, `convex/http.ts:271-272`

**Description:**
In the external tracking HTTP API, URL path parameters and query parameters are used directly:

```typescript
const ref = decodeURIComponent(pathParts[0]);
const since = url.searchParams.get('since');
const until = url.searchParams.get('until');
const limit = url.searchParams.get('limit');
```

While Convex's typed query system prevents SQL injection (Convex is not SQL-based), the `limit` parameter is parsed with `parseInt` without validation beyond what the downstream function provides, and date strings are passed to `new Date()` without format validation.

The `ref` value from the URL path is reflected in error responses (line 244):
```typescript
`No load found with reference '${ref}'`
```

This is not an XSS risk since the API returns JSON, but could be used for error message injection or log injection.

**Remediation:**
- Validate `limit` is a positive integer within bounds before passing downstream
- Validate date parameters match expected ISO 8601 format
- Sanitize the `ref` value before including it in error messages

---

## Non-Findings / Positive Observations

### Memory Corruption Vulnerabilities
**Confidence:** HIGH (95%)
The entire codebase is TypeScript running on V8 (Convex) and Node.js runtimes. There are no native modules, C/C++ bindings, or manual memory management. Buffer operations in `convex/externalTrackingAuthCrypto.ts` use Node.js's `Buffer` API correctly with proper length validation. **No memory corruption vulnerabilities were identified.**

### Cryptographic Implementation
**Confidence:** HIGH (90%)
- API keys use `crypto.randomBytes(32)` — sufficient entropy
- Key hashing uses SHA-256 — appropriate for key lookup (not password storage, which would require bcrypt/argon2)
- Webhook secrets use AES-256-GCM with random IVs and auth tags — correctly implemented
- HMAC-SHA256 used for webhook payload signing — standard practice
- The encrypted secret format (`iv:authTag:ciphertext`) stores all necessary components

### External Tracking API Auth
**Confidence:** HIGH (85%)
The external HTTP API (`convex/http.ts`) has well-structured authentication:
- Bearer token extracted, hashed, and looked up
- Key status (ACTIVE) and expiration checked
- Environment prefix validation prevents sandbox/production confusion
- Permission checks on each endpoint
- BOLA checks in `resolveLoad` verify the load belongs to the requesting org
- Audit logging on all requests
- Proper use of `internalQuery`/`internalMutation` for data layer functions

### WorkOS Auth Integration
**Confidence:** HIGH (85%)
The Next.js web app uses `@workos-inc/authkit-nextjs` for authentication. The callback route uses the framework's `handleAuth()` which handles PKCE, state validation, and session management. The sign-in/sign-up routes properly delegate to WorkOS. Cookie-based session management uses `httpOnly` cookies via the WorkOS SDK.

### S3 Presigned URL Generation
**Confidence:** HIGH (85%)
- Presigned URLs expire after 300 seconds (5 minutes) — appropriate
- File names are sanitized: `args.filename.replace(/[^a-zA-Z0-9.-]/g, '_')`
- Authentication required before generating presigned URLs
- Separate endpoints for general uploads vs POD photos with appropriate folder structures

### Convex Platform Security
**Confidence:** HIGH (90%)
- Convex's typed schema (`convex/schema.ts`) with validators prevents type confusion
- The `internal` prefix on queries/mutations/actions properly restricts server-only functions
- No raw SQL — Convex uses a document-based query API that is not susceptible to injection

---

## Summary of Findings by Severity

| # | Severity | Confidence | Finding |
|---|----------|------------|---------|
| 1 | CRITICAL | 95% | BOLA in Carrier Mobile API — no auth on org-scoped queries/mutations |
| 2 | HIGH | 90% | BOLA in Drivers API — no auth, sensitive data exposure via `includeSensitive` |
| 3 | HIGH | 90% | `getCredentials` public query exposes raw integration API keys |
| 4 | MEDIUM | 75% | Loose phone matching enables identity confusion across orgs |
| 5 | MEDIUM | 85% | Missing auth on Loads API queries |
| 6 | MEDIUM | 75% | Cross-org settings update — no membership verification |
| 7 | MEDIUM | 85% | Missing auth on Integration mutations |
| 8 | LOW | 70% | Webhook SSRF mitigations have gaps |
| 9 | LOW | 95% | IP allowlist is configured but never enforced |
| 10 | LOW | 90% | Rate limiting defined but not enforced |
| 11 | LOW | 70% | Excessive logging of PII and security-sensitive data |
| 12 | LOW | 65% | Insufficient input validation on HTTP API parameters |

---

## Recommended Priority Order

1. **Immediate (Findings 1, 2, 3):** Fix BOLA in carrier mobile and drivers APIs; change `getCredentials` to `internalQuery`. These are exploitable by any authenticated user.
2. **Short-term (Findings 4, 5, 6, 7):** Add authentication and org-membership checks to all remaining public queries and mutations. Fix phone matching logic.
3. **Medium-term (Findings 8, 9, 10):** Implement rate limiting, fix SSRF gaps, either enforce or remove IP allowlist UI.
4. **Ongoing (Findings 11, 12):** Clean up logging, add input validation.
