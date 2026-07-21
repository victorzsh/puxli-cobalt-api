FROM ghcr.io/imputnet/cobalt:11

USER root
COPY --chown=node:node entrypoint.sh /usr/local/bin/puxli-cobalt-entrypoint
RUN chmod 755 /usr/local/bin/puxli-cobalt-entrypoint

USER node
ENTRYPOINT ["/usr/local/bin/puxli-cobalt-entrypoint"]
CMD ["node", "src/cobalt"]
