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
export API_PORT="${PORT:-10000}"

printf '{"%s":{"name":"puxli-vercel","limit":60,"allowedServices":["youtube","tiktok","instagram","twitter"]}}\n' \
    "$PUXLI_API_KEY" > /tmp/puxli-cobalt-keys.json

exec "$@"
