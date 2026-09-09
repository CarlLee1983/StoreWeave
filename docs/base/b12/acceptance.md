# B12 驗收追蹤：共用工具

範圍為 [Spec 0009 F12](../../specs/0009-complete-modular-base.md#3-能力範圍與現況)。依據：[B12 派工契約](assignment.md)、[計畫 §4 B12 卡](../../base-implementation-plan.md#b12--共用工具)、[ADR 0038](../../adr/0038-signed-values-carry-a-key-id.md)。依賴只以[計畫 §3](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

計畫 §4 的出口條件逐項對照：

| 驗收項目 | evidence | status |
| --- | --- | --- |
| 原生 fetch＋AbortSignal 的 timeout 規約 | `timeoutMs` 是整次嘗試的預算，含所有轉址跳數；`test/hardening.test.ts` 驗證轉址不會重啟計時 | implemented |
| response error 分類 | 十種可辨原因：invalid_request／blocked_destination／unsafe_redirect／too_many_redirects／timeout／aborted／network／response_too_large／http_status／invalid_json。`test/failures.test.ts` 逐項覆蓋 | implemented |
| 網路錯誤、無效 JSON、timeout、取消有測試 | `failures.test.ts`：TypeError 傳輸失敗、非 JSON 主體、錯誤 content type、逾時與呼叫端取消分開回報、已取消不送出 | implemented |
| 不安全 retry 有測試 | POST 預設不重送（attempts=1）；宣告 idempotent 才重試；400 不重試、429／503 重試；取消與 blocked destination 不重試；退避遞增 | implemented |
| 受信任目的地 | 完全比對、支援 `host:port`、Unicode 條目正規化為 punycode、子網域不繼承；URL 內嵌帳密／非 http(s)／未開放的明文 http 一律拒絕 | implemented |
| 外部 URL 不能透過 redirect 繞過存取限制 | 手動逐跳、每跳重跑 `checkDestination`；`redirects.test.ts` 驗證離開允許清單、降級為 http、跳進私有位址都被擋；轉址預算 5 跳 | implemented |
| secret redaction | 錯誤訊息只含 origin（path 會帶 webhook token）；request header 不進訊息；回應不交還 `set-cookie`；`hardening.test.ts` 與 `destinations.test.ts` 各有斷言 | implemented |
| 跨 SSR／mail／Admin 的 locale／message namespace／plural／fallback | `@storeweave/i18n` 三者共用；`resolveMessage` 走 fallback chain 且只認自有欄位；`pluralize` 以 Intl.PluralRules 覆蓋三語系 | implemented |
| 三語 fallback 不改變既有金額／日期語意 | `formatMoney` 的 Intl 路徑與 fallback 字串順序與原 theme 實作一致；theme 49 PASS、admin 320 PASS 未改既有斷言 | implemented |
| 時區不改變既有金額／日期語意 | `store.timezone` 經 `ThemeContext.timeZone` 帶到前台四處日期；`format.test.ts` 驗證台北與 UTC 跨日差異；後台以 Asia/Taipei 顯示 | implemented（界線見 README 第 3 點） |
| 日期序列化及時間工具 | `toIsoString` 統一 UTC ISO 8601，對無效日期直接失敗 | implemented |
| crypto 的 sign／verify／encrypt／rotation 使用方式 | `signValue`／`verifySignedValue`／`encryptString`／`decryptString`；輪替為「加一把、改 active、等舊值到期、再移除」 | implemented |
| crypto tamper／rotation tests | `signed-value.test.ts` 24 案：竄改 payload／到期、跨用途、過期、未知 key、非正規編碼、輪替後舊 key 仍可驗；`encryption.test.ts` 10 案含 tamper 與 AAD 綁定 | implemented |
| 選一個實際 consumer 遷移，不生第二套 fetch framework | 六個呼叫端全部遷移（見 README 移轉表）；`demo-erp` 自寫的 `fetchWithTimeout` 已刪除；架構邊界測試確保 Extension 只經 SDK 取得能力 | implemented |
| 本機 HTTP fixture、純 message／date tests | 全部以注入的 fetch 替身與純函式測試完成，不需要真實網路 | implemented |

## 獨立審查

| 片 | 結果 |
| --- | --- |
| 片1 crypto | 一份獨立審查。HIGH：簽發值與密文接受非正規編碼（`token + '='`、前導零到期秒數皆能通過驗證），使同一份授權有多種字串寫法。已修並補 canonical 回歸。MEDIUM：金鑰秘密以字元長度衡量強度、一個測試名稱與斷言不符。LOW：derive 回傳快取參照、型別檢查、錯誤 cause、GCM 訊息數上限。全部已處理 |
| 片2 http-client | 一份獨立審查，結論 Block。五項 HIGH：跨 origin 只丟三個寫死 header、無私網位址防線、`safeUrl` 保留 path、測試情境會打真實網路、demo-erp 推單 204 會被當成失敗而重複建單。八項 MEDIUM 含逾時是每跳而非每次嘗試、可重試回應主體未釋放、GET 帶 body 被誤重試。全部已修 |
| 片3 修正驗證 | 一份獨立驗證。CRITICAL 與 HIGH 皆實測確認修復（七種 IPv4-in-IPv6 寫法全部擋下、公開 IPv6 無誤擋；admin 全套在三種主機時區下各 322 PASS）。另提四項 MEDIUM／LOW：6to4 與 local-use NAT64 仍可繞過、`192.0.0.0/16` 過度封鎖、`safeUrlAttribute` 未濾控制字元、`?? key` 在帶參數時會丟例外。全部已修 |
| 片3 i18n | 一份獨立審查，結論 Block。CRITICAL：私網防線可用 IPv4-mapped IPv6 繞過（`[::ffff:127.0.0.1]` 被 URL parser 正規化成 `[::ffff:7f00:1]`，既不是 `::1` 也不匹配 `fc00::/7`）。HIGH：OrdersPage 測試綁死主機時區，UTC 機器必定失敗。另有 store.timezone 未驗證、`timeZone: undefined` 會退回主機時區、escapeHtml 被用於 URL 屬性、重用 Response 被誤判為可重試等。全部已修 |

## Gates evidence

在最終 source `9b365cc` 上實跑：

| gate | 結果 |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm typecheck:admin` | PASS |
| `pnpm test`（unit） | 73 files／926 PASS |
| `pnpm test:admin` | 324 PASS，於 `TZ=UTC`、`Asia/Taipei`、`America/New_York` 三種環境各跑一次 |
| `pnpm test:integration` | 85 files／713 PASS |
| `pnpm build` | PASS |
| `pnpm build:admin` | PASS |
| Docker smoke commerce | 66 通過／0 失敗 |
| Docker smoke base | PASS（含 commerce 路徑不存在的檢查） |
| native smoke commerce | 65 通過／0 失敗 |
| native smoke base | PASS |

Docker smoke 第一次失敗於 `pnpm install --frozen-lockfile`：三個新 workspace 套件沒有進 `pnpm-lock.yaml` 的 importers。本機 `pnpm install` 判定 lockfile 已是最新而不重寫，最後以三筆 `{}` importer 補上，diff 僅此三行。

## 已知不穩定

兩支 integration 測試在本機會間歇失敗，都不是 B12 迴歸：

- `tests/integration/worker-recovery.test.ts`：連跑三次為 8/8、7/8、8/8；在 B12 之前的 `8390db5` 上同一支也失敗一項且是不同案例。B04 既有的環境敏感測試（`databaseTimeoutMs: 100`、`shutdown.timeoutMs: 250`）。
- `tests/integration/pg-tool.test.ts`：全量跑時失敗過一次（rollback --resume），單獨重跑通過。同屬容器時序敏感。

三次完整 integration 的結果分別是 712、713、713 PASS；上表採用的是最終 source 上、沒有其他重型工作並行時的那一次。處置歸屬 B04／B05 工作線。

## 尚未完成

- B12 整包整合驗收後才可將基準交給 B09。
- 片3 的修正尚未再取得一次獨立審查。
