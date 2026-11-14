#!/usr/bin/env bash
set -euo pipefail

DB="${DATABASE_PATH:-/data/tab.db}"
mkdir -p "$(dirname "$DB")"

# Seed once. Retry the merchant-wallet verification (it calls the Pollar
# Server API, which can be slow on a cold start).
if [ ! -f "$DB" ]; then
  echo "[tab] first boot: seeding $DB"
  for attempt in 1 2 3 4 5; do
    if pnpm seed; then
      break
    fi
    echo "[tab] seed attempt $attempt failed; retrying in 3s"
    sleep 3
  done
else
  echo "[tab] database present: $DB"
fi

echo "[tab] starting api :4000, web :3000, depot :3001, caddy :8080"
# On a small box (e.g. a 1 GB Oracle VM) cap each Next process so the existing
# stack is not pushed into OOM. 0 = leave Node defaults.
if [ "${TAB_NODE_HEAP_MB:-0}" -gt 0 ] 2>/dev/null; then
  export NODE_OPTIONS="--max-old-space-size=${TAB_NODE_HEAP_MB}"
  echo "[tab] node heap capped at ${TAB_NODE_HEAP_MB} MB"
fi

pnpm --filter @tab/api start &
pnpm --filter @tab/web start &
if [ "${TAB_ENABLE_DEPOT:-1}" = "1" ]; then
  pnpm --filter @tab/depot start &
fi
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

# If any process exits, take the container down so the platform restarts it.
wait -n
