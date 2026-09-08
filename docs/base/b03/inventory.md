# B03-start baseline — HTTP 與安全 transport 現況盤點

本文件是 B03／F02 的唯讀盤點。來源是目前工作樹的程式與文件；本次**未執行任何測試**，因此下文的測試項目僅描述測試原始碼涵蓋的宣告，不是新的通過結果。

## 已存在的 release 邊界（B02，不是 B03 缺口）

- [`scripts/releases.mjs`](../../../scripts/releases.mjs) 為 base／commerce 同時選取 runtime、HTTP adapter、seed 與靜態能力；[`scripts/build.mjs`](../../../scripts/build.mjs) 將選取的 HTTP adapter 編入 `@storeweave/selected-http`。
- [`ReleaseHttpAdapter`](../../../apps/api/src/release-adapter.ts) 是目前最小的 release HTTP seam；[`AppModule.forRuntime`](../../../apps/api/src/app.module.ts) 只註冊 `http.controllers(config)`。
- Base adapter 只掛 health、meta、auth、system、extensions；Commerce adapter 才掛商務 REST、callback、storefront，且 MCP 受設定控制：[`base.ts`](../../../apps/api/src/releases/base.ts)、[`commerce.ts`](../../../apps/api/src/releases/commerce.ts)。
- [`base-release.test.ts`](../../../tests/integration/base-release.test.ts) 的原始碼宣告 Base 不掛 `/`、products、orders、MCP、theme assets；[`smoke-base.sh`](../../../scripts/smoke-base.sh) 也列出相同否定路徑。這是既有 B02 release isolation 證據，非本次測試結果。

## 目前 route 與契約來源

| Family | 目前來源／行為 |
| --- | --- |
| Base JSON | `/health/*`、`/api/v1/meta/*`、`/api/v1/auth/*`、`/api/v1/system/*`、`/api/v1/extensions/*`，由 Base adapter 註冊。 |
| Commerce REST | `/api/v1/{products,inventory,orders,promotions,coupons,customers,cart,shipping,refunds,rmas,invoices,loyalty,notification-deliveries,analytics,content/*}`；controller decorators 是目前 URL／method 的唯一來源。 |
| 特殊 transport | `POST /callbacks/:kind/:providerId` 走 provider acknowledgement；`GET /mcp` 回傳 descriptor list，只有 `POST /mcp` 是 JSON-RPC；Storefront 是 HTML／redirect／form routes；admin 與 theme assets 由 [`release-server.ts`](../../../apps/api/src/release-server.ts) 動態掛載。它們不能被誤當成一般 REST envelope。 |
| Descriptor／驗證 | [`CommandDescriptor`／`QueryDescriptor`](../../../packages/platform/contracts/src/descriptors.ts) 已有 input、output、permission、idempotency。Command／Query Bus 分別在執行前驗 input 與授權、執行後驗 output：[`command-bus.ts`](../../../packages/platform/command-bus/src/command-bus.ts)、[`query-bus.ts`](../../../packages/platform/query-bus/src/query-bus.ts)。 |
| 成功／錯誤 | REST 成功使用 [`ok()`](../../../apps/api/src/http/envelope.ts)；[`PlatformExceptionFilter`](../../../apps/api/src/http/exception.filter.ts) 將 `PlatformError` 轉公開 error envelope。callback 與 HTML 路徑有刻意不同的回應。 |
| Auth／防護 | 全域 guard 在 [`AppModule`](../../../apps/api/src/app.module.ts) 註冊；[`auth.ts`](../../../apps/api/src/http/auth.ts) 處理 bearer、session、`@Public`、`@Anonymous`、CSRF 與 external callback。Fastify 的 trusted proxy、body limit、route-specific rate limit 在 [`release-server.ts`](../../../apps/api/src/release-server.ts)；設定欄位在 [`config/schema.ts`](../../../packages/platform/config/src/schema.ts)。 |

## ADR 0024 的未知鍵規則

一般 Command／Query input 必須 `.strict()`，未知鍵為 `VALIDATION_ERROR`／HTTP 400：[ADR 0024](../../adr/0024-strict-command-inputs.md)。Extension 的 **GET query bridge** 是 ADR 0024 明載、B03 必須保留的 bridge policy：[`ExtensionsController.declaredParams`](../../../apps/api/src/controllers/extensions.controller.ts) 只轉送 descriptor 宣告的 query keys，丟棄 `_t` 等無法控制的 cache-buster 並記錄鍵名；其 POST command JSON body **不過濾**，未知鍵仍必須被拒絕。`declaredInputKeys()` 是這個 bridge policy 白名單的唯一來源：[`schema-keys.ts`](../../../packages/platform/contracts/src/schema-keys.ts)。這不主張它是整個 HTTP 層唯一會挑選 query keys 的位置。

## 真正的 B03／F02 缺口

1. 沒有 transport declaration 把 HTTP method/path、request location、auth、success envelope、error 與 descriptor 連結。Controller decorators 與手寫 query/body mapping 是唯一 route 資料源。
2. Meta 只輸出 command/query **input** JSON Schema，不輸出 descriptor output、route、auth 或錯誤契約：[`MetaController`](../../../apps/api/src/controllers/meta.controller.ts)。未找到 OpenAPI／Swagger 產物或生成來源。
3. 未找到 CORS 設定或 Fastify CORS 註冊。`trustProxy`、body limit 與有限 route rate limit 已存在，不應重建。
4. 在此 B03-start baseline，工作卡指定的 `tests/integration/base-http.test.ts` 尚不存在。現在已新增第一個 auth slice；目前進度見 [B03 README](README.md)，完整 B03 coverage 仍待補齊。現有測試原始碼涵蓋 Base isolation、guard／CSRF、cookie、callback、cart rate limit、MCP 與 HTTP contracts；本次未執行，且未見 CORS、proxy-spoof 或完整 transport-document coverage。

## 最小可重用 seam

保留 `ReleaseHttpAdapter` 作 release 邊界，讓它貢獻一份小型 transport declaration：一般 REST entry 只引用既有 Command／Query descriptor；HTML、callback、MCP 以明確 kind 保留其不同回應語意。文件與覆蓋核對從該 declaration 生成；不要搬動 domain module、重寫 Zod schema、或另建第二套 controller 專用 schema。
