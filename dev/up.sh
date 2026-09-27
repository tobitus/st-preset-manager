#!/usr/bin/env bash
# Bring up the st-pm-dev container + mock LLM (PLAN §3). Idempotent.
#   dev/up.sh              normal (plugin mounted)
#   dev/up.sh --no-plugin  acceptance 15 variant (plugin mount omitted)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/sillytavern/sillytavern:1.19.0"
NAME="st-pm-dev"
MODE="plugin"
[[ "${1:-}" == "--no-plugin" ]] && MODE="no-plugin"

mkdir -p "$REPO/dev/config" "$REPO/dev/data" "$REPO/dev/chrome-profile"

# 1. config.yaml: copy from live (READ ONLY source) once, then dev edits
if [[ ! -f "$REPO/dev/config/config.yaml" ]]; then
    cp "$HOME/projects/sillysystem/st/config/config.yaml" "$REPO/dev/config/config.yaml"
    # port 8001 -> 8002, disable plugin/extension auto-update
    sed -i -e 's/^port: 8001$/port: 8002/' \
           -e 's/^enableServerPluginsAutoUpdate: true$/enableServerPluginsAutoUpdate: false/' \
           -e 's/^enableExtensionsAutoUpdate: true$/enableExtensionsAutoUpdate: false/' \
           "$REPO/dev/config/config.yaml"
    grep -q '^enableExtensionsAutoUpdate:' "$REPO/dev/config/config.yaml" || true
    echo "[up] wrote dev/config/config.yaml from live config (port 8002, auto-update off)"
fi

# 2. container
if podman ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    podman rm -f "$NAME" >/dev/null
fi

MOUNTS=(-v "$REPO/dev/config:/home/node/app/config"
        -v "$REPO/dev/data:/home/node/app/data"
        -v "$REPO/extensions/Extension-PromptInspector:/home/node/app/public/scripts/extensions/third-party/Extension-PromptInspector:ro")
if [[ "$MODE" == "plugin" ]]; then
    MOUNTS+=(-v "$REPO:/home/node/app/plugins/st-preset-manager"
             -v "$REPO:/home/node/app/public/scripts/extensions/third-party/st-preset-manager")
else
    MOUNTS+=(-v "$REPO/manifest.json:/mnt/pm-manifest.json:ro")
fi

echo "[up] starting $NAME ($MODE)"
podman run -d --name "$NAME" --network host --hostname st-pm-dev --restart no \
    -e SILLYTAVERN_HEARTBEATINTERVAL=30 \
    "${MOUNTS[@]}" \
    "$IMAGE" >/dev/null

# 3. mock LLM
if [[ -f "$REPO/dev/mock.pid" ]] && kill -0 "$(cat "$REPO/dev/mock.pid")" 2>/dev/null; then
    :
else
    nohup node "$REPO/dev/mock-llm.js" >"$REPO/dev/mock.log" 2>&1 &
    echo $! > "$REPO/dev/mock.pid"
    echo "[up] mock-llm started (pid $(cat "$REPO/dev/mock.pid")) on :8099"
fi

# 4. wait for ST + verify cookie name differs from live + plugin initialized
for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8002/ || true)
    [[ "$code" == "200" ]] && break
    sleep 1
done
if [[ "$code" != "200" ]]; then
    echo "[up] ERROR: ST did not come up on :8002" >&2
    podman logs --tail 40 "$NAME" >&2
    exit 1
fi
cookie=$(curl -si http://127.0.0.1:8002/csrf-token | grep -i '^set-cookie:' | head -1 | cut -d= -f1 | awk '{print $2}')
echo "[up] ST is up (cookie: $cookie)"

if [[ "$MODE" == "plugin" ]]; then
    for i in $(seq 1 10); do
        podman logs "$NAME" 2>&1 | grep -q 'st-preset-manager.*initialized' && break
        sleep 1
    done
    if podman logs "$NAME" 2>&1 | grep -q 'Initializing plugin from .*plugins/st-preset-manager/plugin/index.js'; then
        echo "[up] plugin initialized from plugins/st-preset-manager/plugin/index.js"
    else
        echo "[up] ERROR: plugin did not initialize" >&2
        podman logs --tail 40 "$NAME" >&2
        exit 1
    fi
else
    if podman logs "$NAME" 2>&1 | grep -q 'st-preset-manager.*initialized'; then
        echo "[up] ERROR: plugin initialized despite --no-plugin" >&2
        exit 1
    fi
    echo "[up] running without the plugin (acceptance 15 mode)"
fi
