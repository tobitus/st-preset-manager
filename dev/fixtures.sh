#!/usr/bin/env bash
# Copy fixtures: dev/fixtures/presets = the 20 ST presets + corpus presets
# (PLAN §3). Both dirs are gitignored; run once.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DATA="${PM_LIVE_DATA:-$HOME/projects/sillysystem/st/data/default-user}"
CORPUS="${PM_CORPUS:-$HOME/projects/sillysystem/presets}"

mkdir -p "$REPO/dev/fixtures/presets"
cp "$LIVE_DATA/OpenAI Settings/"*.json "$REPO/dev/fixtures/presets/"
# corpus presets (Sola V1.2, FF4-fork-Lydia, FrankenSIM, Casus Chatfill, …)
cp "$CORPUS/"*.json "$REPO/dev/fixtures/presets/" 2>/dev/null || true
# the Nemo Engine presets (presets/Nemo/; the other presets/ subfolders hold
# variants of files already copied above and would overwrite them)
cp "$CORPUS/Nemo/"*.json "$REPO/dev/fixtures/presets/" 2>/dev/null || true
# Sola V3 Flame: the owner's original file, byte-identical (round 3)
SOLA3_SRC="${PM_SOLA3_SRC:-$HOME/Downloads/☀️ 🧡 Sola V3 Flame 🧡 ☀️.json}"
if [ -f "$SOLA3_SRC" ]; then cp "$SOLA3_SRC" "$REPO/dev/fixtures/presets/Sola V3 Flame.json"; fi
echo "[fixtures] $(ls "$REPO/dev/fixtures/presets" | wc -l) files in dev/fixtures/presets"
