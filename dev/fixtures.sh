#!/usr/bin/env bash
# Copy fixtures: dev/fixtures/presets = the 20 ST presets + corpus presets
# (PLAN §3). Both dirs are gitignored; run once.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DATA="$HOME/projects/sillysystem/st/data/default-user"

mkdir -p "$REPO/dev/fixtures/presets"
cp "$LIVE_DATA/OpenAI Settings/"*.json "$REPO/dev/fixtures/presets/"
# corpus presets (Sola V1.2, FF4-fork-Lydia, FrankenSIM, Casus Chatfill, …)
cp "$HOME/projects/sillysystem/presets/"*.json "$REPO/dev/fixtures/presets/" 2>/dev/null || true
echo "[fixtures] $(ls "$REPO/dev/fixtures/presets" | wc -l) files in dev/fixtures/presets"
