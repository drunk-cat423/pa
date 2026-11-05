#!/bin/sh
# Installed outside the candidate release; the publisher is independent of PA's lifecycle.
set -eu
here=$(dirname "$0")
exec /usr/bin/flock -w 180 "${PA_PUBLISH_LOCK:-/run/lock/pa-storage.lock}" /opt/node-v24.15.0/bin/node "$here/publish-release.mjs" "$1"
