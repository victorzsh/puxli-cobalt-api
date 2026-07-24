#!/bin/sh
set -eu

if [ -z "${RENDER_EXTERNAL_URL:-}" ]; then
    echo "RENDER_EXTERNAL_URL is required" >&2
    exit 1
fi

if [ -z "${PUXLI_API_KEY:-}" ]; then
    echo "PUXLI_API_KEY is required" >&2
    exit 1
fi

umask 077
export API_URL="${RENDER_EXTERNAL_URL%/}/"
export API_PORT="9000"
export YOUTUBE_WORKER_PORT="9100"
export YOUTUBE_WORK_DIR="/tmp/puxli-youtube"

printf '{"%s":{"name":"puxli-vercel","limit":60,"allowedServices":["youtube","tiktok","instagram","twitter","reddit"]}}\n' \
    "$PUXLI_API_KEY" > /tmp/puxli-cobalt-keys.json

exec node /opt/puxli/gateway.mjs "$@"
