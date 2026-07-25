#!/usr/bin/env bash
set -euo pipefail

# Guard against direct imports of the storage backends. During the
# MMKV rollout (Phase 0–4) all callers must go through the dispatcher
# at mobile/lib/location-storage.ts — otherwise the kill-switch flag
# can't redirect them when we flip backends. Only location-storage.ts
# itself and the two backend modules' own tests are allowed to import
# the backends directly.
#
# Deleted in Phase 5 along with the dispatcher.

cd "$(dirname "$0")/.."

# rg is faster but not guaranteed on every runner; use grep for portability.
matches=$(grep -rEn "from ['\"](\.\.?/)*lib/location-(db|queue)['\"]" \
  --include='*.ts' --include='*.tsx' \
  app lib \
  2>/dev/null \
  | grep -Ev "lib/location-storage\.ts:" \
  | grep -Ev "lib/location-queue\.ts:" \
  | grep -Ev "lib/location-db\.ts:" \
  || true)

if [ -n "$matches" ]; then
  echo "ERROR: direct imports from ./location-db or ./location-queue detected."
  echo "Use ./location-storage instead — it's the dispatcher that respects"
  echo "the gps_queue_backend feature flag."
  echo ""
  echo "$matches"
  exit 1
fi

echo "OK: no direct backend imports outside location-storage.ts"
