#!/usr/bin/env bash
# Reset dev data to a clean ST + the 20 import-source presets (PLAN §3).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# exported: dev/seed-settings.mjs reads the same variable
export PM_LIVE_DATA="${PM_LIVE_DATA:-$HOME/projects/sillysystem/st/data/default-user}"
LIVE_DATA="$PM_LIVE_DATA"
PORT="${PM_DEV_PORT:-8002}"

if podman ps --format '{{.Names}}' | grep -qx 'st-pm-dev'; then
    podman stop st-pm-dev >/dev/null
fi

rm -rf "$REPO/dev/data"
mkdir -p "$REPO/dev/data/default-user/OpenAI Settings"

# ST's own CC presets: dropdown list AND the Phase 1 import source
cp "$LIVE_DATA/OpenAI Settings/"*.json "$REPO/dev/data/default-user/OpenAI Settings/"
count=$(ls "$REPO/dev/data/default-user/OpenAI Settings/" | wc -l)

# settings.json generated from a read-only read of the live one
node "$REPO/dev/seed-settings.mjs" "$REPO/dev/data/default-user/settings.json"

# minimal extra dirs ST expects on first boot
mkdir -p "$REPO/dev/data/default-user"/{characters,chats,backups,user}

echo "[reset] data rebuilt: $count presets, fresh settings.json"
podman start st-pm-dev >/dev/null

for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
    [[ "$code" == "200" ]] && break
    sleep 1
done
[[ "$code" == "200" ]] || { echo "[reset] ERROR: ST did not come up" >&2; exit 1; }
echo "[reset] st-pm-dev is up on :$PORT"
