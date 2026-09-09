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
| 片3 i18n | 進行中 |

## 尚未完成

- 完整 integration gate：執行中，結果補於此。
- Docker／native smoke：未跑。
- 片3 獨立審查：進行中。
- B12 整包整合驗收後才可將基準交給 B09。
