#!/usr/bin/env bash
#
# Vercel build for the platform console.
#
# This project owns the PRODUCTION Convex deploy (see apps/admin/README.md
# §3b): on production builds the backend is deployed first, then the console is
# built against the freshly deployed backend with NEXT_PUBLIC_CONVEX_URL
# injected by the Convex CLI. Preview builds skip the deploy entirely — a
# preview must never be able to deploy backend code.
#
# Lives in a script rather than inline in vercel.json because `buildCommand`
# is capped at 256 characters, and because a guard worth having is a guard
# worth being able to run locally:
#
#   VERCEL_ENV=production bash apps/admin/scripts/vercel-build.sh
#
set -euo pipefail

# Vercel runs buildCommand from the project's Root Directory (apps/admin), but
# derive the repo root from the script's own location so local invocation from
# anywhere behaves the same.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

if [ "${VERCEL_ENV:-}" != "production" ]; then
  cd apps/admin && exec bun run build
fi

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  cat >&2 <<'BANNER'

==============================================================
PRODUCTION BUILD BLOCKED: CONVEX_DEPLOY_KEY is not set.

This Vercel project owns the production Convex deploy, so
building without the key would ship a console against a backend
that was never deployed. Failing here is deliberate — falling
back to a plain build is the exact failure this setup prevents.

Fix (one-time, see apps/admin/README.md section 3b):
  1. Convex dashboard -> Settings -> Deploy Keys -> generate a
     PRODUCTION deploy key.
  2. Vercel -> this project -> Settings -> Environment Variables
     -> add CONVEX_DEPLOY_KEY, scoped to Production ONLY.
  3. Redeploy. The log should show `convex deploy` running
     before `next build`.

Note: preview builds keep passing while this is broken, because
they skip the Convex deploy — so production can stay red without
an obvious signal.
==============================================================

BANNER
  exit 1
fi

exec bunx convex deploy \
  --cmd 'cd apps/admin && bun run build' \
  --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
