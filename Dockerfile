FROM node:24-alpine AS bgutil-build

ARG BGUTIL_VERSION=1.3.1
ARG BGUTIL_SHA256=b5400343482820062372e997cc0c9ace18637f8e774cf70b22c58b89b99e9abe

RUN apk add --no-cache build-base python3 cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev pixman-dev pkgconf
RUN wget -qO /tmp/bgutil.tar.gz "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz" \
    && echo "${BGUTIL_SHA256}  /tmp/bgutil.tar.gz" | sha256sum -c - \
    && mkdir -p /build/bgutil \
    && tar -xzf /tmp/bgutil.tar.gz --strip-components=2 -C /build/bgutil "bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}/server"

WORKDIR /build/bgutil
RUN npm ci --no-audit --no-fund \
    && npx tsc \
    && npm prune --omit=dev --no-audit

FROM ghcr.io/imputnet/cobalt:11

USER root
RUN apk add --no-cache python3 py3-pip ffmpeg cairo pango jpeg giflib librsvg pixman libstdc++ \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir \
        "yt-dlp==2026.7.23.234303.dev0" \
        "bgutil-ytdlp-pot-provider==1.3.1"

COPY --from=bgutil-build --chown=node:node /build/bgutil/build /opt/bgutil/build
COPY --from=bgutil-build --chown=node:node /build/bgutil/node_modules /opt/bgutil/node_modules
COPY --chown=node:node entrypoint.sh /usr/local/bin/puxli-cobalt-entrypoint
COPY --chown=node:node gateway.mjs youtube-worker.mjs /opt/puxli/
RUN chmod 755 /usr/local/bin/puxli-cobalt-entrypoint \
    && mkdir -p /tmp/puxli-youtube \
    && chown node:node /tmp/puxli-youtube

USER node
ENTRYPOINT ["/usr/local/bin/puxli-cobalt-entrypoint"]
CMD ["node", "src/cobalt"]
