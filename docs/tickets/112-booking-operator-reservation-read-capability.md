# 112 — Booking operator Reservation 讀取能力

**問題：** SW-137 要提供 operator Reservation HTTP 端點，SW-142 要顯示 Reservation
列表、詳情與付款／退款／通知證據；但 `booking-reservation` 目前只有 Account owner 或
management credential 的 Reservation 讀取 Query，沒有 operator 列表／詳情／付款嘗試
Query。HTTP adapter 不應直接查表或挪用 Booker 的讀取權限。現有退款證據 Query 會
傳出 provider 的自由文字失敗訊息，且未與通知證據 Query 採用同一個 operator actor 守衛；
通知證據 Query 也會透出 Base delivery 的自由文字 `lastError`。兩者都不應直接成為
HTTP／Admin 的 outward DTO。

**狀態：** 已實作並通過 `make verify`；ForgePilot WI-027 已驗證通過，SW-137 可依賴此能力。

**對應 Story：** [SW-154](../../specs/stories/SW-154-operator-reservation-read/)。

## 驗收

- [x] Reservation 模組宣告獨立 `booking-reservation:operator-read` 權限與明確的列表、詳情、付款嘗試證據 Query；QueryBus 權限與 handler 的真人 operator actor 檢查都生效。
- [x] 列表採有界分頁、穩定排序與有限篩選，預設不含 Booker／Guest 聯絡資料或憑證；詳情只回傳工作所需欄位，保留後的匿名化資料維持 `null`。
- [x] 付款、退款與通知證據可依 Reservation 關聯；對外 Query DTO 不含原始 callback、token、provider 自由文字錯誤或不必要 PII。既有退款與通知證據 Query 都收斂為 operator 安全 DTO，不改各自的持久化紀錄。
- [x] 禁止者、非真人 actor、未知 Reservation、無效篩選／分頁都得到安全且可區分的結果；所有以 Reservation ID 取證據的 Query 對不存在的父 Reservation 回報 not-found，而存在但無證據才回空列表。資料庫聚焦測試覆蓋分頁邊界與 Late／Excess payment 證據。
- [x] 如需列表索引，只新增可回退的 Booking Reservation 索引遷移；不改 Reservation 狀態、付款／退款命令或 Commerce。`make verify` 於整合檢查點通過。

## 邊界與依賴

- 此票只改 `packages/booking/reservation` 的 read model、Query 契約、必要索引與測試；不新增 HTTP、Admin UI 或通用 REST-to-Query 路由。
- 是 SW-137 operator HTTP 與 SW-142 Reservation Admin 的前置能力；ForgePilot WI-017 已依賴並通過 WI-027 閘門。
- 涉及營運者個資與付款證據，實作前需 Sol/high 設計、完成後需獨立 Sol/high 安全複審。
