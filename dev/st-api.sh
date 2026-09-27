#!/usr/bin/env bash
# curl with cookie jar + CSRF against the dev instance (PLAN §3).
#   dev/st-api.sh GET /slot
#   dev/st-api.sh POST /slot/load '{"presetId":"…"}'
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$REPO/dev/.cookies.jar"
BASE="${ST_URL:-http://127.0.0.1:8002}"
METHOD="$1"
PATHPART="$2"
BODY="${3:-}"

# fresh cookie jar per boot: token is session-bound
if [[ ! -f "$JAR" ]] || [[ "${METHOD}" == "--fresh" ]]; then
    rm -f "$JAR"
fi
if ! grep -q 'session' "$JAR" 2>/dev/null; then
    curl -s -c "$JAR" -o /dev/null "$BASE/csrf-token"
fi
TOKEN=$(curl -s -b "$JAR" -c "$JAR" "$BASE/csrf-token" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')

if [[ "$METHOD" == "GET" ]]; then
    exec curl -s -b "$JAR" -H "x-csrf-token: $TOKEN" "$BASE/api/plugins/st-preset-manager$PATHPART"
else
    exec curl -s -b "$JAR" -X "$METHOD" -H "x-csrf-token: $TOKEN" -H 'Content-Type: application/json' \
        -d "$BODY" "$BASE/api/plugins/st-preset-manager$PATHPART"
fi
