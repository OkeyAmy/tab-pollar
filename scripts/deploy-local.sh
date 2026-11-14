#!/usr/bin/env bash
# Build the one-origin image, then run it locally on :8080.
# Usage: ./scripts/deploy-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PUB=$(grep -E '^NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY=' .env | cut -d= -f2)
ISSUER=$(grep -E '^NEXT_PUBLIC_USDC_ISSUER=' .env | cut -d= -f2)

docker build -t tab:local \
  --build-arg NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY="$PUB" \
  --build-arg NEXT_PUBLIC_SETTLEMENT_ASSET=USDC \
  --build-arg NEXT_PUBLIC_USDC_ISSUER="$ISSUER" \
  --build-arg NEXT_PUBLIC_DEPOT_URL=/depot \
  .

docker rm -f tab-local >/dev/null 2>&1 || true
docker run -d --name tab-local -p 8080:8080 \
  --env-file .env \
  -e DATABASE_PATH=/data/tab.db \
  -e PORT=4000 \
  -e API_BASE_URL=http://127.0.0.1:4000 \
  -e WEB_ORIGIN=http://localhost:8080 \
  -e DEPOT_ORIGIN=http://localhost:8080 \
  -v tab_data:/data \
  tab:local

echo "TAB running at http://localhost:8080"
echo "logs: docker logs -f tab-local"
