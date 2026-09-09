# B12 — 共用工具

狀態：三片實作完成，片1／片2 各取得一份獨立審查並修完其 HIGH，片3 審查與完整
gates 見下方 evidence。範圍與依賴以[計畫 §3](../../base-implementation-plan.md#3-依賴圖與階段出口)為準；派工契約與現況盤點見 [assignment](assignment.md)。

## 三片

1. `@storeweave/crypto`：常數時間比較、隨機憑證、sha256／HMAC、帶 key id 與到期的簽發值、AES-256-GCM 封裝、設定側的金鑰環（ADR 0038）。
2. `@storeweave/http-client`：對外 HTTP 的逾時／取消、錯誤分類、安全重試、受信任目的地與轉址政策、回應大小上限。
3. `@storeweave/i18n`：訊息樣板與複數、locale fallback、HTML escaping、金額與時間格式化。

三個套件互不 import。`packages/platform/identity` 的 scrypt 密碼雜湊維持原處：密碼 KDF 的成本升級與 key id 輪替是兩套獨立機制，合併會讓兩者都動不了。

## 契約

### 簽發值與金鑰

格式與輪替語意寫在 [ADR 0038](../../adr/0038-signed-values-carry-a-key-id.md)。實作要點：

- `security.signingKeys` 宣告 `id` 與 `secretRef`，`activeSigningKeyId` 指定新值用哪一把。只有一把時可省略，兩把以上必須明說。
- 秘密必須是 base64url 或 hex 編碼且解碼後至少 32 bytes。字元長度不等於熵——32 個 hex 字元只有 16 bytes，`please-change-me-please-change-me` 剛好 32 bytes 卻幾乎沒有熵。用 `generateSigningKeySecret()` 產生。
- 子金鑰以 HKDF 依 purpose 推導，跨用途不能互相偽造。
- 驗證回報 `malformed`／`unknown_key`／`bad_signature`／`expired`，順序固定為格式、金鑰、簽章、到期。簽發值是唯一編碼：`token + '='` 或前導零的到期秒數都會被判為 `malformed`，否則同一份授權會有無限多種寫法，繞過任何以 token 字串記帳的一次性連結。
- 宣告了金鑰卻讀不到秘密，在啟動時就失敗；完全沒宣告則該 release 沒有簽章能力，由 `requireKeyring` 給出可據以修正的訊息。

### 對外 HTTP

- `timeoutMs` 是**整次嘗試**的預算，含所有轉址跳數。
- 重試只給宣告 `idempotent` 的請求或天生無副作用的方法；POST 預設不重送。可重試的狀態碼是 408／425／429／5xx 與傳輸失敗。
- 轉址自己走每一跳並逐跳重跑目的地檢查。跨 origin 時 header 走**白名單**（accept 系列、content-type、user-agent），因為憑證放在 `x-api-key` 這類自訂 header 的 provider 很常見。帶 body 的請求遇到轉址直接失敗，不把副作用重放到新目的地。
- 預設拒絕迴環、私有與 link-local 位址。這是字面位址檢查，**不等於防 DNS rebinding**；需要嚴格隔離的部署仍要在網路層限制出站。內網用途（demo-erp）必須明確 `allowPrivateAddresses`，讓風險留在設定裡看得見。
- 允許清單是完全比對，支援 `host:port`，條目會正規化成 punycode。子網域不從父網域繼承。
- 錯誤訊息只帶 origin：webhook token 與 `/v1/keys/<key>` 這類把秘密放在路徑上的設計很普遍。回應不交還 `set-cookie`。
- Extension 一律走 `ctx.http(...)`，不自己呼叫 fetch。測試情境未給替身時對外 HTTP 直接失敗，不會靜靜打到真實端點。

### 訊息與時間

- 樣板一次掃描填值，代入的值不再被當成樣板。缺參數與多餘參數都失敗——讓字典與呼叫端對不上時在測試炸掉，而不是把 `{total}` 顯示給客戶。
- 複數用 `Intl.PluralRules`。**不引入訊息格式套件**：zh-TW／ja-JP 只有 `other`、en-US 有 `one`／`other`，三個語系全部覆蓋；現有字典沒有任何複數形，為一個尚未使用的能力增加 Admin bundle 成本不划算。日後若需要 select／序數／巢狀，這個決定可以低成本反轉——改的是 `@storeweave/i18n` 一個檔案，呼叫端介面不變。
- 序列化一律 `toIsoString`，對無效日期直接失敗，不把 `Invalid Date` 寫進 payload。
- 顯示一律指定 IANA 時區。`store.timezone` 由 `ThemeContext.timeZone` 帶到前台，這是它第一次真正生效。

## 移轉

| 呼叫端 | 變更 |
| --- | --- |
| `apps/api/src/http/auth.ts` | 本地 `safeEquals` 收斂到 `constantTimeEquals` |
| `packages/extensions/ecpay-logistics/src/provider.ts` | callback 驗章由字串比較改為常數時間比較 |
| `packages/extensions/ecpay-invoice/src/provider.ts` | 原本完全沒有 timeout／abort／重試；現有逾時與 ECPay 雙主機允許清單 |
| `packages/extensions/demo-erp/src/erp-client.ts` | 移除自寫的 `fetchWithTimeout`；health check 允許重試、推送單據不重送 |
| `packages/themes/default/src/{layout,index}.ts` | `escapeHtml`／`formatMoney` 改由共用套件提供；四處日期改用帶時區的格式化 |
| `apps/admin/src/{i18n.tsx,pages/ProductsPage.tsx}` | `t()` 收參數，八處 `.replace('{x}')` 鏈移除 |

順帶修掉的既有缺陷：`deployments/*.schema.json` 未隨 B04 的 worker retention 欄位重新產生；Admin 庫存預測在沒有快照時會顯示「undefined 件」。

## 已知界線

1. **字面位址檢查不是 SSRF 完整防護。** 允許清單上的 host 若解析到內網位址，這一層擋不住。
2. **ECPay 開發票遇到轉址會硬失敗**（POST 帶 body）。這是刻意取捨，但外部端點單方面就能觸發，須寫進 runbook。
3. **後台顯示時區寫死 `Asia/Taipei`**，與 `store.timezone` 是兩個來源。多時區營運時要一併處理。
4. **B09 必須等整包 B12 整合驗收**，不是片1；短效 URL 依賴的是已驗收的簽章與時間契約。
