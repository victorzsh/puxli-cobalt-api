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
export YOUTUBE_SESSION_SERVER="http://127.0.0.1:8080/"
export YOUTUBE_SESSION_INNERTUBE_CLIENT="WEB_EMBEDDED"

printf '{"%s":{"name":"puxli-vercel","limit":60,"allowedServices":["youtube","tiktok","instagram","twitter"]}}\n' \
    "$PUXLI_API_KEY" > /tmp/puxli-cobalt-keys.json
chown node:node /tmp/puxli-cobalt-keys.json

echo "Starting YouTube session generator"
Xvfb :99 -ac -screen 0 1280x720x16 -nolisten tcp > /tmp/puxli-xvfb.log 2>&1 &
sleep 2
DISPLAY=:99 /opt/yt-session-generator/.venv/bin/python \
    /opt/yt-session-generator/potoken-generator.py --bind 127.0.0.1 &
session_pid=$!

attempt=0
until wget -q -O /dev/null http://127.0.0.1:8080/token; do
    if ! kill -0 "$session_pid" 2>/dev/null; then
        echo "YouTube session generator stopped unexpectedly" >&2
        exit 1
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -ge 90 ]; then
        echo "YouTube session generator did not become ready" >&2
        exit 1
    fi
    sleep 2
done

echo "YouTube session is ready"

exec su-exec node "$@"
