#!/usr/bin/env bash
# Add a public origin (and redirect URI) to the Pollar app without dropping the
# existing ones. Usage: ./scripts/pollar-set-origin.sh https://tab-pollar.fly.dev
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:?usage: pollar-set-origin.sh https://your-app.example}"
APP="${POLLAR_APP_ID:-$(grep -E '^POLLAR_APPLICATION_ID=' .env 2>/dev/null | cut -d= -f2)}"
if [ -z "$APP" ]; then
  echo "Set POLLAR_APP_ID or POLLAR_APPLICATION_ID in .env" >&2
  exit 1
fi
URL="${URL%/}"

echo "reading current app config…"
CURRENT=$(./scripts/pollar-mcp.sh get_application "{\"id\":\"$APP\"}")

ORIGINS=$(python3 -c '
import json,sys
d=json.loads(sys.argv[1]); u=sys.argv[2]
o=set(d.get("allowed_origins") or []); o.add(u)
print(json.dumps(sorted(o)))
' "$CURRENT" "$URL")

REDIRECTS=$(python3 -c '
import json,sys
d=json.loads(sys.argv[1]); u=sys.argv[2]
r=set(d.get("allowed_redirect_uris") or []); r.add(u); r.add(u+"/")
print(json.dumps(sorted(r)))
' "$CURRENT" "$URL")

echo "origins:   $ORIGINS"
echo "redirects: $REDIRECTS"

./scripts/pollar-mcp.sh update_application_domains \
  "{\"id\":\"$APP\",\"allowed_origins\":$ORIGINS}" >/dev/null
./scripts/pollar-mcp.sh update_application_redirect_uris \
  "{\"id\":\"$APP\",\"allowed_redirect_uris\":$REDIRECTS}" >/dev/null

echo "✓ $URL added to Pollar origins and redirect URIs"
