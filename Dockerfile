# syntax=docker/dockerfile:1
# 建置階段：安裝依賴並產生 Application Artifact（dist/）。
FROM node:22-bookworm-slim AS builder
WORKDIR /src

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/platform/audit/package.json packages/platform/audit/
COPY packages/platform/authorization/package.json packages/platform/authorization/
COPY packages/platform/bundle/package.json packages/platform/bundle/
COPY packages/platform/command-bus/package.json packages/platform/command-bus/
COPY packages/platform/config/package.json packages/platform/config/
COPY packages/platform/contracts/package.json packages/platform/contracts/
COPY packages/platform/db/package.json packages/platform/db/
COPY packages/platform/event-bus/package.json packages/platform/event-bus/
COPY packages/platform/extension-sdk/package.json packages/platform/extension-sdk/
COPY packages/platform/jobs/package.json packages/platform/jobs/
COPY packages/platform/kernel/package.json packages/platform/kernel/
COPY packages/platform/outbox/package.json packages/platform/outbox/
COPY packages/platform/query-bus/package.json packages/platform/query-bus/
COPY packages/commerce/catalog/package.json packages/commerce/catalog/
COPY packages/commerce/inventory/package.json packages/commerce/inventory/
COPY packages/commerce/order/package.json packages/commerce/order/
COPY packages/extensions/demo-erp/package.json packages/extensions/demo-erp/
COPY packages/extensions/mcp/package.json packages/extensions/mcp/
COPY packages/extensions/mock-payment/package.json packages/extensions/mock-payment/
COPY packages/themes/default/package.json packages/themes/default/
COPY tools/cli/package.json tools/cli/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# 執行階段：只帶編譯後的 JavaScript 與靜態資源，沒有原始碼、沒有編譯工具。
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="StoreWeave Commerce"

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system commerce && useradd --system --gid commerce --home /var/lib/commerce commerce

WORKDIR /opt/commerce/current
COPY --from=builder /src/dist ./
COPY deployments/example-store/commerce.yaml /etc/commerce/commerce.yaml.example
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN printf '#!/bin/sh\nexec node /opt/commerce/current/app/cli.js "$@"\n' > /usr/local/bin/commerce \
 && chmod +x /usr/local/bin/commerce /usr/local/bin/entrypoint.sh \
 && mkdir -p /var/lib/commerce/backups /var/log/commerce /etc/commerce \
 && chown -R commerce:commerce /var/lib/commerce /var/log/commerce

ENV NODE_ENV=production \
    COMMERCE_CONFIG=/etc/commerce/commerce.yaml \
    COMMERCE_ADMIN_DIR=/opt/commerce/current/admin \
    COMMERCE_HOME=/opt/commerce

USER commerce
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["api"]
