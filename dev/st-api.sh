#!/usr/bin/env bash
# curl with cookie jar + CSRF against the dev instance (PLAN §3).
# Bodies are read from a FILE or STDIN (--data-binary @file), never argv:
# FF-class presets are ~64 KB and hit E2BIG ("Argument list too long").
#   dev/st-api.sh GET /slot
#   dev/st-api.sh POST /slot/load dev/load.json
#   echo '{"presetId":"p_…"}' | dev/st-api.sh POST /slot/load
#   dev/st-api.sh POST /presets --raw '{"st":…}'          (tiny bodies only)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$REPO/dev/.cookies.jar"
BASE="${ST_URL:-http://127.0.0.1:${PM_DEV_PORT:-8002}}"
METHOD="${1:?usage: st-api.sh METHOD PATH [body-file|--raw json]}"
PATHPART="${2:?usage: st-api.sh METHOD PATH [body-file|--raw json]}"
ARG3="${3:-}"

# fresh cookie jar on demand: the token is session-bound, a jar from a
# previous container lifetime gets 403 forever
if [[ ! -f "$JAR" ]] || [[ "${METHOD}" == "--fresh" ]]; then
    rm -f "$JAR"
fi
if ! grep -q 'session' "$JAR" 2>/dev/null; then
    curl -s -c "$JAR" -o /dev/null "$BASE/csrf-token"
fi
TOKEN=$(curl -s -b "$JAR" -c "$JAR" "$BASE/csrf-token" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token)}catch{console.error("st-api: no csrf token — session expired? rm dev/.cookies.jar");process.exit(1)}})')

if [[ "$METHOD" == "GET" ]]; then
    exec curl -s -b "$JAR" -H "x-csrf-token: $TOKEN" "$BASE/api/plugins/st-preset-manager$PATHPART"
fi

CURL_ARGS=(curl -s -b "$JAR" -X "$METHOD"
    -H "x-csrf-token: $TOKEN" -H 'Content-Type: application/json')
case "$ARG3" in
    "")     exec "${CURL_ARGS[@]}" "$BASE/api/plugins/st-preset-manager$PATHPART" ;;
    --raw)  exec "${CURL_ARGS[@]}" --data-binary @- "$BASE/api/plugins/st-preset-manager$PATHPART" ;;
    *)      exec "${CURL_ARGS[@]}" --data-binary @"$ARG3" "$BASE/api/plugins/st-preset-manager$PATHPART" ;;
esac
