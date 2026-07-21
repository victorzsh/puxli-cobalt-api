FROM ghcr.io/imputnet/cobalt:11

USER root

ARG YT_SESSION_GENERATOR_COMMIT=8cf18c81999d924e44da95dd6af996c9ac8598f8c9c

RUN apk add --no-cache \
        ca-certificates \
        chromium \
        font-freefont \
        freetype \
        harfbuzz \
        nss \
        py3-pip \
        py3-virtualenv \
        python3 \
        xvfb \
    && mkdir -p /opt/yt-session-generator \
    && wget -q "https://github.com/imputnet/yt-session-generator/archive/${YT_SESSION_GENERATOR_COMMIT}.tar.gz" -O /tmp/yt-session-generator.tar.gz \
    && tar -xzf /tmp/yt-session-generator.tar.gz --strip-components=1 -C /opt/yt-session-generator \
    && rm /tmp/yt-session-generator.tar.gz \
    && python3 -m venv /opt/yt-session-generator/.venv \
    && /opt/yt-session-generator/.venv/bin/pip install --no-cache-dir -r /opt/yt-session-generator/requirements.txt \
    && sed -i 's/await self.sleep(0.5)/await self.sleep(2)/' /opt/yt-session-generator/.venv/lib/python3.*/site-packages/nodriver/core/browser.py

COPY --chown=node:node entrypoint.sh /usr/local/bin/puxli-cobalt-entrypoint
RUN chmod 755 /usr/local/bin/puxli-cobalt-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/puxli-cobalt-entrypoint"]
CMD ["node", "src/cobalt"]
