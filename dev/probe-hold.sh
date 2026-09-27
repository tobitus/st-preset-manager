#!/usr/bin/env bash
# Start a HELD probe tab (stays open across tool calls), log ready.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
TAB="${1:-default}"
# kill previous holder of this tab
if [[ -f "dev/probe-$TAB.pid" ]]; then
    kill -9 "$(cat "dev/probe-$TAB.pid")" 2>/dev/null || true
    rm -f "dev/probe-$TAB.pid"
fi
pkill -9 -f "chrome-profile-$TAB( |$)|chrome-profile( |$)" 2>/dev/null || true
nohup node dev/probe.mjs hold "$TAB" > "dev/probe-$TAB.log" 2>&1 &
echo $! > "dev/probe-$TAB.pid"
echo $$ > /dev/null # holder pid above; browser pid appended by hold mode below
for i in $(seq 1 90); do
    if grep -q '"ok":true' "dev/probe-$TAB.log" 2>/dev/null; then
        echo "tab $TAB held (probe pid $(cat dev/probe-$TAB.pid))"; exit 0
    fi
    if grep -q '"error"' "dev/probe-$TAB.log" 2>/dev/null; then
        cat "dev/probe-$TAB.log"; exit 1
    fi
    sleep 1
done
echo "timeout waiting for tab $TAB"; cat "dev/probe-$TAB.log"; exit 1
