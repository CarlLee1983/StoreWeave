# Booking Product Release 實作計畫

- 日期：2026-09-19
- 狀態：planning complete；等待依本計畫拆成核准 Story，尚未授權實作。
- 規格：[Spec 0011](specs/0011-booking-product-release.md)
- 架構決策：[ADR 0052](adr/0052-booking-is-a-separate-product-release.md)
- 訪談決策：[Booking decision log](booking-decision-log.md)

## 1. 執行規則

本計畫只管理依賴、邊界與驗收，不取代 Spec。每個工作包在派工前須拆成一張或多張 Story；一張 Story 的
In Scope 只碰一個 package boundary。跨 package 契約以 expand／migrate／contract 拆開，使每張 Story 完成後
repository 仍可建置與驗證。每個 package 同一時間只有一個 writer。

不因目錄整理搬移 `packages/commerce/*`，不順手通用化 Customer、Invoice、Promotion、Pricing 或 Inventory。
只有 Booking 實際需要的 Release、Admin／HTTP contribution 與 Payment Provider 接縫進入本計畫。

## 2. 工作圖

| ID | 工作包 | 主要 owner／邊界 | 依賴 | 出口證據 |
| --- | --- | --- | --- | --- |
| K00 | 固定跨產品基準 | architecture tests、release artifacts | — | Base／Commerce 現況 manifest、artifact import graph 與 public-contract baseline 可重跑 |
| K01 | 抽出共用 Release 契約 | `packages/platform/release` | K00 | 純 metadata root manifest 與 target projections；bootstrap、contract checks 無產品 import，Commerce legacy media 欄位退出共用契約 |
| K02 | 分離產品組裝 | `packages/releases/*` | K01 | Base／Commerce definitions 由新入口建置，舊 bundle 組裝來源移除 |
| K03 | HTTP／server projection | API host 與 release contract | K01–K02 | API host 只掛載 server projection 選取的 adapter，worker／Admin 不匯入 controller，無產品 id 分支 |
| K04 | Admin／browser projection | Admin shell 與 release contract | K01–K02 | route、navigation、permission、UI entry 建置期組裝；browser 不匯入 backend code，Commerce 先以單一 contribution 相容接入 |
| K05 | Config／CLI／build 收斂 | config、CLI、build scripts | K01–K02 | 設定檔名與產品命令由 ReleaseDefinition 提供，移除共用工具的產品 id 判斷 |
| K06 | Payment ABI expand | `packages/platform/extension-sdk` | K00 | 新的 domain-neutral Provider ABI 與 contract tests 存在，舊 consumer 暫可建置 |
| K07 | Payment adapters migrate | mock-payment、ECPay 各自 Story | K06 | 兩個 adapter 實作新 ABI，callback 仍以唯一 reference 對應；ECPay 補 refund contract 與 staging gate |
| K08 | Commerce payment migrate | `packages/commerce/order` | K07 | Order 使用新 ABI，既有付款、延後付款、回呼與退款行為不變 |
| K09 | Payment ABI contract | extension-sdk 與 contract ledger | K08 | Order 專用 Provider path 移除，沒有 fallback 或舊 ABI consumer |
| K10 | Property module | `packages/booking/property` | K01 | Property／Room Type migrations、commands、queries、capability 與 module contract 完整 |
| K11 | Booking Theme 基線 | `packages/themes/booking-default` | K10 | 首頁、房型列表與詳情 renderer；缺 renderer 的 contract check 可重現 |
| K12 | Availability module | `packages/booking/availability` | K10 | Room Night、價格覆寫、Quote、固定順序鎖列與最後一間房競態測試 |
| K13 | Search／Quote storefront | Booking page declarations 與 Theme | K11–K12 | 日期／人數搜尋、Quote fingerprint、改價與售完結果可由真頁面走通 |
| K14 | Reservation core | `packages/booking/reservation` | K12 | pending／confirmed／expired／cancelled、Reservation-first lock order、同交易占房與釋放、到期工作 |
| K15 | Payment attempts 與異常收款 | `packages/booking/reservation` | K09、K14 | retry／idempotency、唯一 winning attempt、callback race、退款、Late／Excess Payment 與失敗證據 |
| K16 | 匿名管理與個資 | `packages/booking/reservation` | K14 | 單次 Access Grant、token hash、clean URL cookie、撤銷／重發、明確 Account claim、retention anonymization |
| K17 | 取消與通知閉環 | Booking reservation mapping | K15–K16 | 自助／營運取消、部分退款金額、通知重試與營運可見失敗 |
| K18 | Booking HTTP 與 Release | Booking adapter、`packages/releases/booking` | K03、K05、K13–K17 | `booking.yaml`、API／Worker／Theme／Extension 靜態 artifact 可建置與啟動 |
| K19 | Booking Admin | Booking Admin contributions | K04、K10、K12、K17 | 房型、價格、房況與 Reservation 操作，直接 URL 仍由後端授權 |
| K20 | 跨產品 closure | repository integration、docs | K18–K19 | Spec 0011 §9 全部有證據，target import 與產品隔離 scan 通過，`make verify` 通過，剩餘 release gates 明列 |

## 3. 依賴順序

```text
K00 → K01 → K02 ─┬→ K03 ──────────────────────────────┐
                 ├→ K04 ─────────────────────────┐    │
                 └→ K05 ────────────────────┐    │    │
K00 → K06 → K07 → K08 → K09 ───────────┐    │    │    │
K01 → K10 ─┬→ K11 → K13 ───────────────┼────┼────┼→ K18 ─┐
           └→ K12 → K14 ─┬→ K15 ─┐     │    │    │       │
                          └→ K16 ─┴→ K17┘    │    └→ K19 ─┤
                                             └─────────────┘
                                                           ↓
                                                          K20
```

K03、K04、K05 可在 K02 後由不同 writer 並行。K10 與 K06 可在 K01 後並行。K15 必須等 K09，避免 Booking
成為舊 Payment ABI 的新 consumer。K18 是第一個完整 Booking artifact checkpoint；K20 前不能宣稱跨產品復用完成。

## 4. 各階段驗收

### 階段 A：組裝接縫（K00–K05）

- Base／Commerce 的 module graph、migration manifest、Theme 與公開 route 保持 byte-stable 或有明確等價對照。
- `packages/platform/release` 不匯入 `@storeweave/commerce-*` 或 `@storeweave/booking-*`。
- Root manifest 只含 metadata；server、worker、Admin browser 與 CLI 各自從 package subpath 或等價 projection
  載入 executable contributions。API host、Admin shell、CLI 與 build scripts 不以 release id 列舉產品。
- Server／worker／CLI 不匯入 React 或 Admin source；Admin browser 不匯入 Nest、DB、migration、secret 或 provider；
  worker 不匯入 HTTP controller。
- Commerce Admin 可先由一個整體 contribution 包裝現有 routes；後續可按模組拆，但不能保留第二套路由來源。

### 階段 B：Payment ABI（K06–K09）

- 新 ABI 不含 Order／Reservation 名稱或欄位。
- Mock Payment 的既有行為保持；ECPay 的付款、redirect／form post、延後付款與 callback 驗證保持，並新增可驗證的
  refund contract。ECPay staging refund UAT 未完成前保留 provider release gate。
- Commerce 遷移後公開 Command／Query／Event 與資料 schema 不變。
- K09 移除舊型別、adapter 與 compatibility branch；contract artifact 證明沒有 consumer。

### 階段 C：Booking domain（K10–K17）

- 每個 module 各自擁有 migration、資料表、permission、commands、queries、events、jobs 與 capability declaration。
- Property → Availability → Reservation 的靜態相依無 cycle；跨模組操作只經 capability。
- 日期與價格使用 Property 時區與單一幣別；Room Type occupancy 與 Room Night sellable units 使用不同欄位與驗證。
- 建立後的 callback、取消、到期與期限延長先鎖 Reservation，再鎖 Payment Attempt，最後才按日期鎖 Room Night。
- Access Grant、management token、PII redaction、retention、退款與通知失敗都有 operator-visible evidence；原始
  management token 不進通知、URL、DB 或 log。

### 階段 D：產品交付（K18–K20）

- 從乾淨資料庫可啟動 Booking API、Worker、Storefront 與 Admin。
- Target import scan 證明 browser／server／worker／CLI 沒有跨 target executable import；Booking artifact dependency
  scan 沒有 Commerce implementation，資料庫沒有 Commerce tables。
- Commerce 與 Base regression 全綠；Booking 端到端旅程及失敗情境全綠。
- 外部 ECPay UAT、真實 SMTP、正式部署設定與營運驗收分列 release gate，不以本機 mock 取代。

## 5. Story 拆分約束

每張 Story 至少包含：目標、唯一 package boundary、公開契約、資料 ownership、預期錯誤、migration／rollback、
最低有用測試與 acceptance evidence。涉及下列事項時需要 Sol/high 設計及獨立 Sol/high review：ReleaseDefinition
公開介面、Payment ABI、Room Night 併發與持久資料 migration。

同一工作包若碰多個 package，按「contract expand → consumer migrate → contract cleanup」拆 Story，並在工作圖中
用顯式依賴串接。不得以暫時破壞 main、跳過 contract checks 或把多 package 塞進一張 Story 來縮短圖。

## 6. Migration、發布與回復

- K01–K09 是程式與建置契約遷移，不改 Commerce 業務資料；每個 checkpoint 可回復程式版本。
- Booking migrations 只作用於新的 Booking database，不掃描、複製或改寫 Commerce 資料。
- Room Night、Reservation 與付款 migration 上線後只做向前 additive 變更；任何 contract 清理另需實際資料證據。
- 每個 Product Release 產生自己的版本、manifest 與 artifact；不能拿 Commerce backup 還原到 Booking。
- 本計畫不授權 deploy、正式資料 migration、外部 UAT、commit、push 或 GitHub 寫入。

## 7. 規劃交付紀錄

- 2026-09-19：完成五輪 design tree，使用者接受 Q1–Q44 的建議答案並確認 shared understanding；逐項摘要保存於
  [Booking decision log](booking-decision-log.md)。
- 已更新 `CONTEXT.md`、跨應用基底文件與 ADR 0052。
- 獨立 Sol/high 規格審查發現並修正：management link 的 durable notification 衝突、付款重試與雙重成功、callback
  race、ECPay refund 缺口、Account linkage、target artifact 隔離，以及 occupancy／inventory 用詞混淆。
- 本輪僅修改文件，不執行應用測試；完成前執行 Markdown／連結／diff 檢查及同一 reviewer 的 delta review。
