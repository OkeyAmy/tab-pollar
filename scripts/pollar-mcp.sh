#!/usr/bin/env bash
# Call a Pollar MCP Gateway tool over Streamable HTTP using curl (IPv4).
# Node's fetch times out on this endpoint from some networks; curl does not.
#
#   ./scripts/pollar-mcp.sh whoami
#   ./scripts/pollar-mcp.sh check_application_readiness '{"id":"cmw..."}'
set -euo pipefail
cd "$(dirname "$0")/.."

TOOL="${1:?usage: pollar-mcp.sh <tool> [json-args]}"
ARGS="${2:-{\}}"
PAT="$(grep -E '^POLLAR_PAT=' .env | cut -d= -f2)"

payload=$(python3 -c '
import json,sys
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))
' "$TOOL" "$ARGS")

curl -4 -sS --max-time 60 https://mcp.api.pollar.xyz/mcp \
  -H "Authorization: Bearer ${PAT}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$payload" \
  | sed -n 's/^data: //p' \
  | tail -1 \
  | python3 -c '
import json,sys
raw=sys.stdin.read().strip()
if not raw:
    print(json.dumps({"error":"empty response"})); raise SystemExit(0)
d=json.loads(raw)
r=d.get("result")
if isinstance(r,dict) and "content" in r:
    for c in r["content"]:
        if c.get("type")=="text":
            t=c.get("text","")
            try: print(json.dumps(json.loads(t),indent=2))
            except Exception: print(t)
else:
    print(json.dumps(d,indent=2))
'
