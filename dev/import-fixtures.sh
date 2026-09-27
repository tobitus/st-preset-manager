#!/usr/bin/env bash
# Import dev/fixtures/presets/*.json into the library via POST /presets
# (Phase 1 check 2). Body via --data-binary @file: no argv size limit.
# Idempotent: an already-imported preset returns 409 and is skipped with
# its existing id; reprints the library afterwards.
#   dev/import-fixtures.sh            all fixtures
#   dev/import-fixtures.sh 'FF.*'     subset (egrep on the filename)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$REPO/dev/fixtures/presets"
FILTER="${1:-}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

ok=0; skip=0; reject=0; fail=0
for f in "$DIR"/*.json; do
    base="$(basename "$f" .json)"
    if [[ -n "$FILTER" ]] && ! echo "$base" | grep -Eq "$FILTER"; then continue; fi
    node -e '
        const fs = require("fs");
        const [out, file, name] = process.argv.slice(1);
        fs.writeFileSync(out, JSON.stringify({ st: JSON.parse(fs.readFileSync(file, "utf8")), name }));
    ' "$TMP" "$f" "$base"
    res="$(dev/st-api.sh POST /presets "$TMP")"
    if [[ "$res" == *'"id"'* && "$res" != *'"error"'* ]]; then
        id="$(echo "$res" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')"
        echo "[import] ok   $base -> $id"; ok=$((ok+1))
    elif [[ "$res" == *'conflict'* ]]; then
        echo "[import] skip $base (already imported)"; skip=$((skip+1))
    elif [[ "$res" == *'"error"'* ]]; then
        echo "[import] reject $base: $res"; reject=$((reject+1))
    else
        echo "[import] FAIL $base: $res"; fail=$((fail+1))
    fi
done
echo "[import] $ok imported, $skip skipped, $reject rejected (non-preset), $fail failed"
[[ "$fail" == 0 ]]
