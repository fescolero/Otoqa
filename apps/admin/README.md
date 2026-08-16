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

### 3b. Atomic Convex deploys (vercel.json)

`apps/admin/vercel.json` makes THIS project the owner of production Convex
deploys via `scripts/vercel-build.sh` (Vercel caps `buildCommand` at 256
characters, so the logic lives in the script — run it locally with
`VERCEL_ENV=production bash apps/admin/scripts/vercel-build.sh` to test the
guard): on **production** builds it runs `convex deploy` from the repo root
first (deploying every backend change on `main`) and then builds the console
against the freshly deployed backend, with `NEXT_PUBLIC_CONVEX_URL` injected
by the CLI. Preview builds skip the deploy and build normally. This kills the
"frontend deployed but Convex didn't" failure mode and stops laptop/side-
session `convex dev` runs from being the last word on production code —
whatever is on `main` is what's deployed.

One-time setup:
1. Convex dashboard → your project → **Settings → Deploy Keys** → generate a
   **Production** deploy key.
2. Vercel → this project → Settings → Environment Variables → add
   `CONVEX_DEPLOY_KEY` = that key, **Production environment ONLY** (never
   Preview — a preview must never be able to deploy backend code).
3. Redeploy. The build log should show `convex deploy` running before
   `next build`.

Note: keep the other Vercel project (tenant app) on a plain build — exactly
ONE project owns the Convex deploy, or every push deploys the backend twice.

This is the setup for when a PRODUCTION Convex deployment exists. Until then,
see §3c.

### 3c. While the project is still on a DEV Convex deployment

`convex deploy` only targets **prod or preview** deployments — there is no CI
path to a dev deployment (`npx convex dev` is that path). So until a production
Convex deployment exists, the atomic deploy above is not the setup you want.

Set this on the Vercel project instead, and leave `CONVEX_DEPLOY_KEY` unset:

```
NEXT_PUBLIC_CONVEX_URL=<your dev deployment URL>
```

The build then skips the Convex deploy, builds the console against that
deployment, and prints a banner saying it shipped no backend changes. Functions
and schema reach the dev deployment when someone runs `npx convex dev` from a
developer machine — **pushing to `main` does not deploy them**.

The dev deployment also needs the console's own env vars (`STAFF_ISSUER`,
`STAFF_JWKS_URL`, `STAFF_EMAIL_ALLOWLIST`), or every page shows
*"Platform console is not enabled on this deployment"* — that check is
per-deployment, so dev and prod each need their own.

When you move to production, add `CONVEX_DEPLOY_KEY` (Production scope only) and
the build switches to the atomic path on its own; nothing else changes.

**Build failure decoder**

| Banner / error | Meaning |
| --- | --- |
| `BUILD BLOCKED: no Convex backend configured` | Neither env var is set — the console would have no backend at all. |
| `no Convex deployment configuration found` (Convex CLI) | `CONVEX_DEPLOY_KEY` is set but is not a valid prod/preview key. |
| `NOTE: this build did NOT deploy backend code` | Expected in the dev setup. Not an error. |

Preview builds skip the Convex deploy in both setups, so they keep passing while
a production build is broken — production can stay red with no obvious signal.

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
