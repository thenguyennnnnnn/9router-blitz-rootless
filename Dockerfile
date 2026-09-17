# syntax=docker/dockerfile:1
# Rootless wrapper for blitz.cloud.
# Pinned upstream for stability. Change the tag deliberately when you want to upgrade.
ARG UPSTREAM_IMAGE=decolua/9router:0.5.75
FROM ${UPSTREAM_IMAGE}

# Build-time root is fine. blitz.cloud only forbids root at runtime.
USER root

# 9Router already uses /app/data. Make the runtime paths explicitly writable by UID/GID 1000,
# which is the identity blitz.cloud forces for every app.
RUN mkdir -p /app/data /app/data-home \
    && chown -R 1000:1000 /app/data /app/data-home

COPY --chown=1000:1000 rootless-start.sh /usr/local/bin/9router-rootless-start
RUN chmod 0755 /usr/local/bin/9router-rootless-start

ENV NODE_ENV=production \
    PORT=20128 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    HOME=/app/data-home \
    NEXT_TELEMETRY_DISABLED=1

# This makes blitz.cloud detect /app/data as a folder that should be kept between restarts.
VOLUME ["/app/data"]
EXPOSE 20128

# Do NOT use the upstream root entrypoint (it runs chown + su-exec at startup).
USER 1000:1000
ENTRYPOINT []
CMD ["/usr/local/bin/9router-rootless-start"]
