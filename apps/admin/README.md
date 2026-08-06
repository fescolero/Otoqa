# Otoqa Platform Console (`apps/admin`)

Internal provider/maintainer dashboard — **platform staff only**. Deployed as its own
Vercel project at `admin.otoqa.com`. Design record: `docs/platform-admin-console-plan.md`.

## How access works

1. Staff sign in through a **dedicated staff WorkOS project** (NOT the tenant project).
2. The AuthKit access token carries the staff project's issuer.
3. Every Convex function under `convex/platform/` calls `requirePlatformStaff`
   (`convex/lib/auth.ts`): token issuer must equal `STAFF_ISSUER` **and** the email must
   be on `STAFF_EMAIL_ALLOWLIST`. Tenant WorkOS and Clerk tokens are rejected by
   construction. No env vars set ⇒ console disabled on that Convex deployment.

## One-time setup

### 1. Staff WorkOS project
- Create a new WorkOS project (e.g. "Otoqa Internal"). Use AuthKit with **Google OAuth
  (social login)** — not an enterprise SSO connection.
- Configure the JWT template to include the `email` claim (the allowlist check needs it).
- Add redirect URI: `https://admin.otoqa.com/callback` (plus `http://localhost:3100/callback` for dev).
- Note the client ID → `STAFF_CLIENT_ID` below.

### 2. Convex deployment env vars
```
STAFF_ISSUER=https://api.workos.com/user_management/<STAFF_CLIENT_ID>
STAFF_JWKS_URL=https://api.workos.com/sso/jwks/<STAFF_CLIENT_ID>
STAFF_EMAIL_ALLOWLIST=you@otoqa.com,teammate@otoqa.com
```
Then redeploy Convex so `auth.config.ts` registers the staff provider.

### 3. Vercel project
- New project on the same repo; **Root Directory: `apps/admin`**.
- Domain: `admin.otoqa.com`.
- Env vars (this project only — the tenant project gets none of these):
```
WORKOS_CLIENT_ID=<STAFF_CLIENT_ID>
WORKOS_API_KEY=<staff project API key>
WORKOS_COOKIE_PASSWORD=<32+ char random>
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://admin.otoqa.com/callback
NEXT_PUBLIC_CONVEX_URL=<same Convex deployment as the tenant app>
```
- Enable Vercel Authentication on preview deployments.
- Recommended ignored-build-step (both projects) so pushes only rebuild what changed.

### 4. Staff accounts
Use dedicated Google accounts for console access; enforce 2-step verification.
Offboarding = disable the Google account **and** remove the email from
`STAFF_EMAIL_ALLOWLIST` (dual kill).

## Local dev
```
bun install
cd apps/admin && bun run dev   # port 3100
```
Point `.env.local` at a dev Convex deployment that has the STAFF_* vars set.
