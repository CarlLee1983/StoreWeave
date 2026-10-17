# syntax=docker/dockerfile:1
# Dedicated tutorial image; shared release packaging remains unchanged.
FROM node:22-bookworm-slim AS builder
ARG STOREWEAVE_RELEASE=notes
ARG STOREWEAVE_SOURCE_REVISION
WORKDIR /src
RUN corepack enable
COPY . .
RUN test "$STOREWEAVE_RELEASE" = notes \
 && pnpm install --frozen-lockfile \
 && STOREWEAVE_RELEASE=notes STOREWEAVE_SOURCE_REVISION="$STOREWEAVE_SOURCE_REVISION" node scripts/build.mjs --skip-admin \
 && mkdir -p /runtime-root/opt/notes/current /runtime-root/opt/notes/media-deps /runtime-root/etc/notes \
 && cp -R dist/. /runtime-root/opt/notes/current/ \
 && pnpm --dir /runtime-root/opt/notes/media-deps add --save-exact sharp@0.35.0 \
 && cp -R /runtime-root/opt/notes/media-deps/node_modules /runtime-root/opt/notes/current/node_modules \
 && cp deployments/notes.example.yaml /runtime-root/etc/notes/notes.yaml.example

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="StoreWeave Notes tutorial"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gpg tini \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.org.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /runtime-root/ /
COPY docker/notes-entrypoint.sh /usr/local/bin/notes-entrypoint.sh
RUN groupadd --system --gid 999 notes \
 && useradd --system --uid 999 --gid notes --home /var/lib/notes notes \
 && printf '#!/bin/sh\nexec node /opt/notes/current/app/cli.js "$@"\n' > /usr/local/bin/storeweave \
 && chmod +x /usr/local/bin/storeweave /usr/local/bin/notes-entrypoint.sh \
 && mkdir -p /var/lib/notes/backups /var/log/notes /etc/notes \
 && chown -R notes:notes /var/lib/notes /var/log/notes
ENV NODE_ENV=production
USER 999:999
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/notes-entrypoint.sh"]
CMD ["api"]
