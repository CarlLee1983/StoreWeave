# 114 — DST 整合測試等待有界排程輪替

**問題：** `tests/integration/scheduler.test.ts` 共用一個 runtime，前面的案例累積註冊
多個 schedule。`ensureScheduled` 的預設 5 秒是**整輪**預算；重負載時會把後段
schedule 延到下一個 tick，並從延後處輪替。兩個 DST 案例卻各在單次呼叫後
立即前進注入時間並檢查所有日期，偶發把合法延後誤判為 DST 計算錯誤。

**狀態：** 測試修正與 ForgePilot fresh snapshot 完整 gate 已通過。本票只修正測試的等待語意，不改 production 的時間計算、
5 秒預算、輪替、`catchUp`、資料庫 migration 或 ForgePilot goal。

## 驗收

- [x] DST 測試在每個注入時刻，以有上限的 tick 重試等到**該測試的 schedule**
      watermark 到達預期 occurrence，才前進到下一個時刻；超出上限時提供
      `deferred/failed` 診斷。
- [x] 原本 spring-forward 與 fall-back 的精確 UTC occurrence 斷言保留。
- [x] 聚焦 scheduler integration、型別檢查與 `make verify` 通過。
- [x] ForgePilot 對後續候選取得 fresh snapshot PASS，才算解除 gate。

## 證據

- ForgePilot `VR-013`／`EV-016`：整套 integration 的 scheduler 28 個案例中
  DST 兩例失敗，分別只留下第一天與最後一天 occurrence；同一檔聚焦重跑
  28/28 通過。
- `packages/platform/kernel/src/recurring.ts` 的 `ensureScheduled` 有整輪 deadline，
  預算不足時記錄 `deferred` 並讓下個 tick 從延後處續跑；既有 unit 測試已
  涵蓋此輪替契約。DST 測試原本忽略回傳結果。
- 修正後 scheduler integration 連續三次 28/28、型別檢查通過；本機
  `make verify` 通過（unit 1452、admin 351、integration 989）。
- ForgePilot `VR-014`／`EV-017` 未通過：快照的 unit 階段在
  admin projection、release baseline、pg-tool、SMTP transport 四例逾時，
  未進入 integration；因此不能把本機通過當作 fresh snapshot PASS。
- ForgePilot `VR-016`／`EV-019` 在固定 snapshot 完整通過（unit 1452、
  admin 351、integration 989），WI-013／014／015 皆取得 fresh PASS；
  `forgepilot start WI-016` 接受並進入 RUNNING。
