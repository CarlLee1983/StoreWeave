# B12 — 共用工具：派工契約與第一片派工單

狀態：`planned`，尚未開始 implementation。本文件具體化 [Base 計畫 §4 B12 卡](../../base-implementation-plan.md#b12--共用工具)，不另建一套相依來源；前置依賴一律以 [§3 依賴表](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

- 前置：B03（`done`，見 [B03 紀錄](../b03/README.md)）。B12 自身不依賴 B04／B05。
- 下游：B09 Storage 的短效 URL 直接吃本包的 sign／verify／expiry 契約；B06 Mail 的模板 escaping、多語與時間格式吃本包的 i18n 與時間契約。依 §3.1，B09 必須等 B12 **完整整合驗收**後才從該基準開工，介面凍結不能取代前置完成。
- 基準 commit：`837870c`（B04 結案）。B05 排程線在另一分支／worktree 進行，本包不得寫入 kernel worker、job registry、jobs 或 scheduler 檔案。

## 1. 現況盤點（2026-09-09）

以下位置是本包的收斂目標，不是既有缺陷清單以外的重構授權。標「已複核」者由主代理直接讀原始碼確認，其餘為 scout 盤點結果。

### 對外 HTTP

非測試的對外 `fetch` 呼叫點只有三個（已複核）：

| 位置 | 現況 |
| --- | --- |
| `packages/extensions/demo-erp/src/erp-client.ts:86` | 自備 `fetchWithTimeout`（AbortController＋setTimeout），有 timeout、無 retry、無錯誤分類 |
| `packages/extensions/ecpay-invoice/src/provider.ts:47` | 裸 `fetch`，**無 timeout、無 abort、無 retry**；失敗只看 `response.ok` |
| `apps/admin/src/api.ts:491` | 瀏覽器端呼叫自家 API，不屬本包的「對外」範圍 |

`packages/extensions/ecpay-logistics/src/provider.ts` 目前只有 fake mode，尚無 HTTP 實作；本包提供契約，不替它補真實 provider。

`ExtensionContext`（`packages/platform/extension-sdk/src/context.ts:33-47`）目前提供 `logger`、`secret()`、`now()`，**沒有 http 入口**——所以 extension 只能各自寫 fetch。這是「第二套 fetch framework」的成因，也是本包必須補的 SDK 接線。

### 翻譯與 escaping

- Admin 字典：`apps/admin/src/i18n.tsx`，`LOCALES = ['zh-TW', 'en-US', 'ja-JP']`，70+ key。無 `Intl.PluralRules`，複數以分開的 key 拼接。
- Storefront：`packages/themes/default/src/layout.ts` 的 `formatMoney`（`Intl.NumberFormat`，失敗回落 `toFixed`）與 `escapeHtml`（已複核，`&<>"'` 五項替換正確，有 `packages/themes/default/test/escaping.test.ts`）。
- `escapeHtml` 目前住在 **theme package**。B06 的 mail 模板不能 import theme，這是本包要把它搬到共用入口的直接理由。

### 日期與時區

無第三方日期套件（根 `package.json` 已複核）。序列化一律 `toISOString()`，顯示層才用 `toLocaleDateString(ctx.locale)`。設定已有 `store.locale` / `store.timezone`（`packages/platform/config/src/schema.ts:44-48`，commerce 預設 `zh-TW`／`Asia/Taipei`，base 預設 `en`／`UTC`），但**沒有任何程式碼真的讀 `store.timezone` 做換算**。

### 密碼學與 redaction

| 現況 | 位置 |
| --- | --- |
| scrypt 密碼雜湊，成本參數寫進雜湊字串，`timingSafeEqual` 比對 | `packages/platform/identity/src/password.ts` |
| ECPay CheckMacValue：SHA-256＋`timingSafeEqual` | `packages/extensions/ecpay/src/check-mac-value.ts` |
| ECPay 發票 AES-128-CBC 加解密 | `packages/extensions/ecpay-invoice/src/provider.ts:54-62` |
| API token 比對 `timingSafeEqual` | `apps/api/src/http/auth.ts` |
| log／audit redaction（key 名稱 regex，深度上限 6） | `packages/platform/audit/src/redact.ts` |

**沒有 key id、沒有 key rotation**；secret 一律走 `runtime.secrets` / `ctx.secret(secretRef)`，`config` 的 `secrets` 區塊只有 `provider`／`file`，**沒有簽章金鑰欄位**。

一個待處置的不一致：`packages/extensions/ecpay-logistics/src/provider.ts:100` 的 callback 簽章用 `signature !== expected` 直接字串比較，同 repo 的 `check-mac-value.ts` 卻用 `timingSafeEqual`。本包把它列為收斂目標之一，由主代理決定是在片二一併處理或另開修正。

## 2. 本包的結構決策

新增三個內聚 package，而不是一個 `utils` 雜物袋。三者相互不 import，各自有自己的 consumer 與測試：

| package | 範圍 |
| --- | --- |
| `@storeweave/crypto` | random、hash、HMAC sign／verify、對稱 encrypt／decrypt、key id 與輪替解析、常數時間比對 |
| `@storeweave/http-client` | 對外 fetch 的 timeout／abort、錯誤分類、安全 retry 規約、受信任目的地與 redirect 政策、request/response redaction |
| `@storeweave/i18n` | message namespace／plural／fallback、HTML escaping、金額與日期格式化、時區換算 |

`packages/platform/identity` 既有的 scrypt 密碼雜湊**不搬進 `@storeweave/crypto`**：密碼 KDF 的成本參數與升級路徑是 identity 的領域決策，搬動會製造無收益的相容風險。

### 需要先做比較才能定案的選型

依 §1.3，這兩項在實作前先完成指定比較並由主代理決策，不由工作線自行選：

1. **訊息格式套件**：`Intl.PluralRules`＋現有字典是否足夠，或需引入 ICU MessageFormat 實作。比較條件：三語既有 key 全數保留、bundle size 對 Admin build 的影響、SSR 與 mail 端可用、Node 22 與 Zod 3 相容。Spec 0009 §5 明列「不要求為選用框架重翻全部 UI」。
2. **簽章金鑰的推導方式**：單一 HMAC 金鑰＋key id，或每用途 HKDF 子金鑰。影響 B09 短效 URL 與 B06 密碼重設連結能否共用同一組金鑰而不互相偽造。

### 需要 ADR

key id 與輪替契約一旦發行就綁住已流出的簽章值（短效 URL、重設連結），事後改動不可逆，符合 [decision-records](../../adr/README.md) 的門檻。片一交付須包含一份 ADR：`docs/adr/0038-signed-values-carry-a-key-id.md`，含 `**Falsified if:**` 條件並在其中以反引號列出所依賴的檔案。

## 3. 切片與出口

一次只推進一片，每片整合驗收後才開下一片。

| 片 | 範圍 | 為何是這個順序 |
| --- | --- | --- |
| 1 | `@storeweave/crypto`＋時間／到期序列化；config 的簽章金鑰區塊；ADR 0038 | B09 的短效 URL 同時需要簽章與到期，這是通往 B06 的關鍵路徑 |
| 2 | `@storeweave/http-client`；遷移 `ecpay-invoice` 與 `demo-erp` 兩個真實 consumer；`ExtensionContext` 補 http 入口 | 有兩個既有 consumer 可驗證，不會產生無人使用的抽象 |
| 3 | `@storeweave/i18n`；`escapeHtml` 搬出 theme；plural／fallback；`store.timezone` 真正生效 | 依賴片一的時間契約；B06 模板直接消費 |

出口條件沿用計畫 §4 B12 卡：網路錯誤、無效 JSON、timeout、取消與不安全 retry 都有測試；外部 URL 不能透過 redirect 繞過存取限制；三語 fallback 與時區不改變既有金額／日期語意；crypto 有 tamper 與 rotation 測試；**不生第二套 fetch framework**。

## 4. 第一片派工單

依 [§3.1 派工單格式](../../base-implementation-plan.md#每片派工單格式)。

```text
Session／工作包／切片：C（共用服務線）／B12／片1 crypto 與時間契約
模式：實作。完成條件：@storeweave/crypto 與時間序列化工具有正式實作、
      至少一個真實 consumer 已遷移、ADR 0038 已寫、片1 focused tests 與
      typecheck／unit 通過，並由未參與實作的 Sol/high reviewer 審過。
起始 commit：837870c（B04 結案）
已完成前置與證據：B03 done（docs/base/b03/README.md、acceptance.md）。
      B04 done 但非本包前置。B05 在另一分支，資源與檔案不重疊。
主代理 owner／worktree／branch：待使用者指派 session；worktree 依 §3.1 從
      837870c 建立，branch 建議 b12-shared-utils，不得沿用 b05-scheduler 的環境
可寫檔案、新檔與 consumer：
      新增 packages/platform/crypto/**（src、test、package.json、tsconfig）
      consumer 一：apps/api/src/http/auth.ts 的 token 常數時間比對收斂到共用入口
      consumer 二：packages/extensions/ecpay-logistics/src/provider.ts:100
                  的字串比較改為常數時間比較（附回歸）
      不得寫入：kernel worker／job-registry／jobs／outbox（B05 線）、
               identity/password.ts（保留在 identity）、themes/**（片3）
引用的已定契約、所需共用接線與 migration 提案：
      沿用 B03 已驗收的 transport／auth／error 宣告與 B01／B02 的 capability、
      release registration 邊界。需 A 整合的共用接線：
        - packages/platform/config/src/schema.ts 新增簽章金鑰區塊
          （key id 清單＋active key id＋secretRef；base schema 是 .strict()，
           兩份 schema 都要動）
        - 根 package.json／tsconfig／build 對新 package 的接線
        - packages/platform/bundle 的 release 註冊（如需要）
      本片不提出 migration；金鑰來自 secrets，不落 DB。
      片1 preflight 必查：目前是否已有「已持久化的簽章值」需要相容處理；
      查無則在交付中明確記錄，不預設沒有。
focused tests／必要整合 gates／測試資源／執行時段：
      新增 packages/platform/crypto/test/*.test.ts：sign／verify round-trip、
      tamper 偵測、過期、key rotation（舊 key 仍可驗、新值用 active key 簽）、
      未知 key id 拒絕、常數時間比較。
      日期：ISO 序列化與 store.timezone 解析的純函式測試。
      命令：pnpm typecheck、pnpm test、以及所觸及 auth flow 的 regression。
      完整 integration 與 Docker／native smoke 由 A 排程，同一主機一次一組；
      /tmp 日誌檔名加 b12- 前綴避免與 B05 線互蓋。
獨立 reviewer 與結果：Sol/high，未參與實作者；跨模組＋密碼學＋公開契約屬高風險。
      實作本身依 §2 留在該 session 主代理，不得默默降給 Terra。
交付 source identity／checks／風險與回復：依 §6 格式記錄 HEAD、實際選用版本、
      passed／failed／not-run checks。回復：本片不改資料，回復即為移除新
      package 與還原 consumer；但金鑰契約一旦發行即綁住已流出的簽章值，
      這是 ADR 0038 要記的不可逆點。
交回 A 的事項與下一個可執行切片：交回 config schema 與根設定的精確 diff 需求；
      A 整合並驗收後，才開片2（http-client）。B09 要等整包 B12 驗收，不是片1。
```

## 5. 已知風險

1. **簽章契約外流不可逆**：短效 URL 與重設連結一旦發出就在使用者手上。片一必須先定 key id 格式與驗章時的 key 查找順序，之後只能新增 key、不能改語意。
2. **B05 檔案衝突**：排程線同樣會碰 config schema。A 必須指定寫入順序，不讓兩線各改後再猜合併語意。
3. **抽象先行**：三個 package 都要求至少一個真實 consumer 一起遷移；只有 API 空殼與成功路徑不能關閉任何一片。
4. **翻譯選型的擴散成本**：若比較結論是引入訊息格式套件，Admin build 與 SSR 都受影響；決策前不得先寫依賴該套件的程式碼。
