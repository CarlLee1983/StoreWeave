# syntax=docker/dockerfile:1
# 建置階段：安裝依賴並產生 Application Artifact（dist/）。
ARG STOREWEAVE_RELEASE=commerce
FROM node:22-bookworm-slim AS builder
ARG STOREWEAVE_RELEASE
WORKDIR /src

RUN corepack enable

# 只先帶進每一個 workspace 的 manifest，讓相依安裝可以被 layer cache 命中。
# 這份清單必須與實際的 workspace 一一對應——少一個，lockfile 裡就有一個
# 找不到 manifest 的 importer，pnpm 會放棄 frozen lockfile 改成整包重解，
# 症狀是安裝階段開始下載所有平台的 esbuild／rollup 然後卡住。
# `tests/unit/dockerfile-workspaces.test.ts` 守著這件事。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/platform/audit/package.json packages/platform/audit/
COPY packages/platform/authorization/package.json packages/platform/authorization/
COPY packages/platform/bundle/package.json packages/platform/bundle/
COPY packages/platform/cache/package.json packages/platform/cache/
COPY packages/platform/command-bus/package.json packages/platform/command-bus/
COPY packages/platform/config/package.json packages/platform/config/
COPY packages/platform/contracts/package.json packages/platform/contracts/
COPY packages/platform/crypto/package.json packages/platform/crypto/
COPY packages/platform/http-client/package.json packages/platform/http-client/
COPY packages/platform/i18n/package.json packages/platform/i18n/
COPY packages/platform/db/package.json packages/platform/db/
COPY packages/platform/identity/package.json packages/platform/identity/
COPY packages/platform/event-bus/package.json packages/platform/event-bus/
COPY packages/platform/extension-sdk/package.json packages/platform/extension-sdk/
COPY packages/platform/jobs/package.json packages/platform/jobs/
COPY packages/platform/kernel/package.json packages/platform/kernel/
COPY packages/platform/mail/package.json packages/platform/mail/
COPY packages/platform/notifications/package.json packages/platform/notifications/
COPY packages/platform/outbox/package.json packages/platform/outbox/
COPY packages/platform/query-bus/package.json packages/platform/query-bus/
COPY packages/platform/storage/package.json packages/platform/storage/
COPY packages/commerce/cart/package.json packages/commerce/cart/
COPY packages/commerce/catalog/package.json packages/commerce/catalog/
COPY packages/commerce/coupon/package.json packages/commerce/coupon/
COPY packages/commerce/customer/package.json packages/commerce/customer/
COPY packages/commerce/inventory/package.json packages/commerce/inventory/
COPY packages/commerce/invoice/package.json packages/commerce/invoice/
COPY packages/commerce/loyalty/package.json packages/commerce/loyalty/
COPY packages/commerce/notification/package.json packages/commerce/notification/
COPY packages/commerce/order/package.json packages/commerce/order/
COPY packages/commerce/promotion/package.json packages/commerce/promotion/
COPY packages/commerce/refund/package.json packages/commerce/refund/
COPY packages/commerce/content/package.json packages/commerce/content/
COPY packages/commerce/rma/package.json packages/commerce/rma/
COPY packages/commerce/shipping/package.json packages/commerce/shipping/
COPY packages/extensions/demo-erp/package.json packages/extensions/demo-erp/
COPY packages/extensions/ecpay/package.json packages/extensions/ecpay/
COPY packages/extensions/ecpay-invoice/package.json packages/extensions/ecpay-invoice/
COPY packages/extensions/ecpay-logistics/package.json packages/extensions/ecpay-logistics/
COPY packages/extensions/mcp/package.json packages/extensions/mcp/
COPY packages/extensions/mock-invoice/package.json packages/extensions/mock-invoice/
COPY packages/extensions/mock-payment/package.json packages/extensions/mock-payment/
COPY packages/themes/default/package.json packages/themes/default/
COPY tools/cli/package.json tools/cli/

RUN pnpm install --frozen-lockfile

COPY . .
RUN case "$STOREWEAVE_RELEASE" in base|commerce) ;; *) exit 1 ;; esac \
 && STOREWEAVE_RELEASE="$STOREWEAVE_RELEASE" pnpm build \
 && if [ "$STOREWEAVE_RELEASE" = commerce ]; then NAME=commerce; CONFIG=deployments/example-store/commerce.yaml; else NAME=storeweave; CONFIG=deployments/storeweave.example.yaml; fi \
 && mkdir -p "/runtime-root/opt/$NAME/current" "/runtime-root/etc/$NAME" \
 && cp -R dist/. "/runtime-root/opt/$NAME/current/" \
 && cp "$CONFIG" "/runtime-root/etc/$NAME/$NAME.yaml.example"

# 執行階段：只帶編譯後的 JavaScript 與靜態資源，沒有原始碼、沒有編譯工具。
FROM node:22-bookworm-slim AS runtime
ARG STOREWEAVE_RELEASE
LABEL org.opencontainers.image.title="StoreWeave ${STOREWEAVE_RELEASE}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /runtime-root/ /
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Keep the existing Commerce UID/GID so existing data volumes retain access.
RUN case "$STOREWEAVE_RELEASE" in commerce) NAME=commerce ;; base) NAME=storeweave ;; *) exit 1 ;; esac \
 && groupadd --system --gid 999 "$NAME" \
 && useradd --system --uid 999 --gid "$NAME" --home "/var/lib/$NAME" "$NAME" \
 && printf '#!/bin/sh\nexec node /opt/%s/current/app/cli.js "$@"\n' "$NAME" > "/usr/local/bin/$NAME" \
 && chmod +x "/usr/local/bin/$NAME" /usr/local/bin/entrypoint.sh \
 && printf '%s\n' "$STOREWEAVE_RELEASE" > /usr/local/share/storeweave-release \
 && mkdir -p "/var/lib/$NAME/backups" "/var/log/$NAME" "/etc/$NAME" \
 && chown -R "$NAME:$NAME" "/var/lib/$NAME" "/var/log/$NAME"

ENV NODE_ENV=production
USER 999:999
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["api"]
