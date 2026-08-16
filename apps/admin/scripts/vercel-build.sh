#!/usr/bin/env bash
#
# Vercel build for the platform console.
#
# Two supported modes, chosen by whether CONVEX_DEPLOY_KEY is set:
#
#   KEY SET (the eventual production setup — README §3b)
#     This project owns the Convex deploy: the backend is deployed first, then
#     the console is built against it with NEXT_PUBLIC_CONVEX_URL injected by
#     the Convex CLI. Frontend and backend ship together, so "deployed the app
#     but not the functions" cannot happen.
#
#   NO KEY (where the project is today: a DEV Convex deployment)
#     `convex deploy` only targets prod/preview deployments — there is no CI
#     path to a dev deployment, that's what `npx convex dev` is for. So the
#     build must NOT try, and must not block either. It builds the console
#     against whatever NEXT_PUBLIC_CONVEX_URL is set on the Vercel project,
#     and warns loudly that this build shipped no backend changes.
#
# Run it locally to check either path:
#   VERCEL_ENV=production bash apps/admin/scripts/vercel-build.sh
#
set -euo pipefail

# Vercel runs buildCommand from the project's Root Directory (apps/admin), but
# derive the repo root from the script's own location so local invocation from
# anywhere behaves the same.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

plain_build() {
  cd apps/admin && exec bun run build
}

# Previews never deploy backend code, by design — a preview must not be able to.
if [ "${VERCEL_ENV:-}" != "production" ]; then
  plain_build
fi

if [ -n "${CONVEX_DEPLOY_KEY:-}" ]; then
  exec bunx convex deploy \
    --cmd 'cd apps/admin && bun run build' \
    --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
fi

# No deploy key: the console still has to know which backend to talk to, and
# that can only come from the project's env vars here. Without it the build
# would produce a console that renders "not configured" for everyone, so fail
# early with the actual fix rather than shipping that.
if [ -z "${NEXT_PUBLIC_CONVEX_URL:-}" ]; then
  cat >&2 <<'BANNER'

==============================================================
BUILD BLOCKED: no Convex backend configured.

Neither CONVEX_DEPLOY_KEY nor NEXT_PUBLIC_CONVEX_URL is set, so
this build has no backend to point the console at.

Set ONE of these on the Vercel project:

  Using a DEV Convex deployment (current setup)
    NEXT_PUBLIC_CONVEX_URL = your dev deployment URL
      (Convex dashboard -> the deployment -> Settings -> URL,
       or `npx convex dev` prints it)
    Backend changes reach dev via `npx convex dev` from a
    developer machine — CI cannot deploy to a dev deployment.

  Using a PRODUCTION Convex deployment (see README section 3b)
    CONVEX_DEPLOY_KEY = a Production deploy key, Production
    environment ONLY. The build then deploys the backend and
    injects NEXT_PUBLIC_CONVEX_URL itself.
==============================================================

BANNER
  exit 1
fi

cat >&2 <<BANNER

--------------------------------------------------------------
NOTE: this build did NOT deploy backend code.

CONVEX_DEPLOY_KEY is not set, so the console is being built
against an existing deployment:
  ${NEXT_PUBLIC_CONVEX_URL}

Convex functions and schema changes reach that deployment only
when someone runs `npx convex dev` (dev) or `npx convex deploy`
(prod). If the console shows "Could not find public function",
the backend is behind this build.
--------------------------------------------------------------

BANNER

plain_build
