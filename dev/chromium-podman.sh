#!/usr/bin/env bash
# Chromium for the dev checks when the host has none: runs Fedora's
# chromium in a podman container sharing the host network (CDP port and ST
# on 127.0.0.1) with the repo mounted at the same path (profile dirs, file
# uploads and downloads must live under the repo). Build the image once:
#   podman build -t localhost/pm-chromium:latest -f dev/chromium.Containerfile dev
# then run a check with PM_CHROME="$PWD/dev/chromium-podman.sh".
# The container is named after the --user-data-dir profile, removed before a
# new start and when the calling process (the check) exits, because killing
# this wrapper does not stop a container run through a remote podman.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="default"
for a in "$@"; do
    [[ "$a" == --user-data-dir=* ]] && PROFILE="$(basename "${a#--user-data-dir=}")"
done
NAME="pm-chromium-$PROFILE"
podman rm -f "$NAME" >/dev/null 2>&1 || true
CALLER=$PPID
( while kill -0 "$CALLER" 2>/dev/null; do sleep 2; done; podman rm -f "$NAME" >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
exec podman run --rm -i --name "$NAME" --network host --userns keep-id --shm-size 1g \
    --security-opt label=disable \
    -v "$REPO:$REPO" -e HOME=/tmp \
    localhost/pm-chromium:latest chromium-browser --no-sandbox "$@"
