#!/usr/bin/env bash
# Tear the dev environment down; data stays (PLAN §3).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if podman ps -a --format '{{.Names}}' | grep -qx 'st-pm-dev'; then
    podman stop st-pm-dev >/dev/null
    podman rm st-pm-dev >/dev/null
fi
if [[ -f "$REPO/dev/mock.pid" ]]; then
    kill "$(cat "$REPO/dev/mock.pid")" 2>/dev/null || true
    rm -f "$REPO/dev/mock.pid"
fi
echo "[down] st-pm-dev removed, mock stopped. Data kept in dev/data."
