# Spec 0011 — Booking Product Release 與跨產品組裝

- 日期：2026-09-19；程式盤點基準：`866ceaf`。
- 狀態：approved；ready for Story decomposition，尚未授權實作。
- 決策來源：[ADR 0052](../adr/0052-booking-is-a-separate-product-release.md)。
- 執行入口：[Booking 實作計畫](../booking-implementation-plan.md)。
- 詞彙依根目錄 `CONTEXT.md`：Product Release、Base Module、Product Module、Property、Room Type、
  Room Night、Booking Quote、Reservation、Booker、Guest、Cancellation Policy、Reservation Payment Attempt、
  Late Payment、Excess Payment、Reservation Access Grant。
- 訪談決策：[Booking decision log](../booking-decision-log.md)。

## 1. 目標與完成定義

建立 StoreWeave 的第二個完整產品 Booking，證明同一套 Platform 與 Base 能支援住宿預訂，而不把 Commerce
改成多模式程式，也不在共用層加入產品名稱判斷。Booking 是獨立建置、部署並使用獨立資料庫的 Product Release。

第一個完整切片涵蓋：瀏覽房型、依日期與人數查詢供應、取得 Booking Quote、建立暫時占用房晚的
`pending_payment` Reservation、由 Provider 完成即時或延後付款、確認、到期、取消、退款、通知，以及後台管理
Property、Room Type、逐日供應、價格與 Reservation。

完成同時要求跨產品組裝接縫成立：ReleaseDefinition 是 backend、HTTP、Admin、CLI、Theme、Extension 與設定
的單一建置來源；Base、Commerce 與 Booking 都能由它產生各自的靜態 artifact。

## 2. 使用者與情境

1. 作為訪客，我要依入住日、退房日與人數看到仍可售的房型與總價。
2. 作為 Booker，我不登入也能建立 Reservation、完成付款並收到只能單次兌換的安全管理連結。
3. 作為 Booker，我要在付款期限內保有已選房晚，不會付款成功才發現超賣。
4. 作為 Booker，我要在自助取消期限內整筆取消並取得全額退款。
5. 作為已登入的 Booker，我要能從自己的 Account 查看與操作連結到我的 Reservation。
6. 作為營運者，我要管理房型、每日容量與房價，並查看、取消與退款 Reservation。
7. 作為營運者，我要看見退款失敗、通知失敗與 Late Payment，而不是讓它們靜默消失。
8. 作為 Theme 作者，我只需替 Booking modules 宣告的頁面提供 renderer。
9. 作為產品組裝者，我要選取 Booking modules、Theme 與 Payment Extension，而不修改 Platform 或 Base。
10. 作為 Commerce 維護者，我要既有資料、設定與公開契約在組裝重構後保持相容。

## 3. 產品模型

### 3.1 Property 與 Room Type

第一版一個 Booking Release 只啟用一個 Property。Property 擁有地址、時區、幣別、入住與退房時間及預設政策。
Room Type 擁有名稱、每房最大入住人數、床型、設施、入住限制與 Base Media reference；Base Content 只承載品牌故事、交通、
附近景點與 FAQ 等編輯內容，不是房型事實來源。

Room Type 以數量出售，不在訂房時指定實體房號。數量為一時可涵蓋整棟或單一房間出租。

### 3.2 Booking Quote 與價格

Booking Quote 是非持久性試算，不占用 Room Night，也不是永久價格承諾。第一版價格來源只有 Room Type 基本
每晚價格及指定日期覆寫；人數只驗證每房最大入住人數。每個 Property 使用單一幣別，金額以整數最小貨幣單位表示，顯示價
為含稅價，不另收服務費。

Quote 回傳不可竄改的 fingerprint。請求的 `roomCount` 不得超過每晚 available units；`adults + children` 不得
超過 `roomCount × maxOccupancyPerUnit`，且每個可售單位至少有一位成人。建立 Reservation 時，系統在交易內重新檢查供應、逐晚價格與政策：完全
一致才建立；內容變更時回傳新 Quote 供 Booker 再次確認；不可售時拒絕。Reservation 凍結逐晚價格、幣別、
總額與 Cancellation Policy。

### 3.3 Reservation

一筆 Reservation 只包含一個 Property、一個 Room Type、一段連續日期及該房型一個或多個可售單位。不同房型建立不同
Reservation。日期、Room Type 或房數建立後不可修改；改期或改房須取消並依當下價格與供應重訂。Booker 聯絡
資料、主要 Guest 姓名與住宿備註可更新，但須 audit。

第一版契約狀態只有：

```text
pending_payment → confirmed
pending_payment → expired
pending_payment → cancelled
confirmed       → cancelled
```

`pending_payment` 與 `confirmed` 占用 Room Night；`expired` 與 `cancelled` 不占用。住宿前、住宿中與已過住宿日期
依 Property 當地日期推導，不保存 `checked_in`、`completed` 或 `no_show`。

### 3.4 Booker、Guest 與存取

建立 Reservation 不要求登入。Reservation 保存 Booker 姓名、Email、電話、主要 Guest 姓名、成人與兒童數，
以及選填住宿備註；不收同行者完整名單、證件、生日、國籍或護照。

Email 不直接承載長效 management token。通知寄出短期、單次的簽章 Reservation Access Grant；兌換命令驗證
簽章、用途、期限、generation 與未使用 nonce 後，才簽發隨機 management token，將其放入 `HttpOnly`、
`Secure`、`SameSite=Strict` 的 scoped cookie，並以 303 轉址到不含憑證的 URL。Reservation 資料只保存
management token hash；原始 management token 不進通知、URL、DB 或 log。Access Grant 不能直接查詢、取消或
更新 Reservation，且兌換一次後失效。重發會遞增 generation，使舊 Grant 與 management token 失效。

Reservation number 加 Email 不構成授權。Reservation 只能連到目前已驗證的 authenticated Account，或由持有
有效 management session 的 Booker 在重新登入後主動 claim；不得接受 client supplied account id，也不得依
Email 相同自動連結。登入後的 Account 存取仍須驗證 ownership。

Booking config 必須提供 retention policy。住宿結束超過期限後，排程匿名化不再需要的 Booker／Guest 個資；
付款、退款與 audit 只保留必要識別。保存期限由營運與適用法規決定，不寫進 Base。

## 4. Product Module 邊界

| Module | 擁有 | 對外能力 | 不擁有 |
| --- | --- | --- | --- |
| `booking-property` | Property、Room Type、結構化房型事實與 Media reference | 讀取有效房型與每房最大入住人數 | 文章、媒體位元組、房晚、Reservation |
| `booking-availability` | Room Night sellable／reserved units、nightly price、Quote | 查房、報價、同交易占用與釋放 | Booker、付款、Reservation 狀態 |
| `booking-reservation` | Reservation、Booker／Guest 快照、付款嘗試、退款、到期與產品通知 mapping | 建立、付款、查詢、取消、匿名管理 | Provider 實作、媒體、Content |

第一版不另拆 pricing、guest、payment、policy 或 booking-notification module。模組只經宣告的 capability 與
Command／Query／Event 互動，不跨表。

## 5. Availability 與併發

`booking-availability` 以 `(room_type_id, local_date)` 唯一識別 Room Night，至少保存 `sellable_units`、
`reserved_units` 與 nightly price。入住日包含、退房日不包含。Room Type 的 `max_occupancy_per_unit` 管入住人數，
Room Night 的 `sellable_units` 管可出售房數，兩者不得共用 `capacity` 名稱。

建立 Reservation 時，系統按日期遞增建立或取得所有 Room Night、以相同順序鎖列、檢查每晚可售數量，然後在
同一交易增加 reserved units 並建立 Reservation。任何一晚不足就整筆失敗。取消、到期及調低 sellable units
使用相同鎖定順序；sellable units 不得低於 reserved units。

Booking config 的安全預設為：最遠可訂 365 天、單筆最長 30 晚、一般 `pending_payment` 保留 15 分鐘。
延後付款可採 Provider 回傳的較長期限。單筆房數另有請求上限，且不得超過每晚 available units。日期、人數、
房數與範圍在進入資料庫前驗證。

## 6. 付款、取消與通知

Payment Provider 契約只收唯一 `reference`、給人看的 `displayReference`、amount、currency 與 method；不收
Order 或 Reservation 欄位。Commerce 與 Booking 各自擁有付款嘗試、狀態轉換與付款成功後效果。第一版只接受
Provider 可驗證結果的即時或延後付款；不支援到店付款、人工匯款或訂金尾款。

每個 Reservation Payment Attempt 有唯一 reference，狀態為 `created`、`submitted`、`awaiting_payment`、
`succeeded`、`failed` 或 `expired`。付款啟動 Command 必須 idempotent：相同操作重送回傳同一 Attempt；只有前一筆
明確 `failed` 或 `expired`，且 Reservation 仍為有效 `pending_payment` 時才能建立下一筆。`submitted` 或
`awaiting_payment` 尚未終結時不得平行建立新 Attempt。

所有付款 callback、取消、Reservation 到期與 deferred payment 期限延長，先鎖 Reservation row，再依固定順序
鎖相關 Payment Attempt；需要釋放房晚時最後按日期順序鎖 Room Night。同一交易重查目前狀態後決定唯一結果。
第一筆可適用的成功付款成為 `winning_payment_attempt_id` 並確認 Reservation；後續另一筆成功付款是 Excess
Payment，只記錄並全額退款。若期限延長先取得鎖，原到期 job 看到新版期限後 no-op 或重排；若到期先完成，
後到的付款資訊不得復活 Reservation。

顧客在 Cancellation Policy 截止前可整筆取消並全額退款。營運者可整筆取消並指定零到實收金額之間的退款及
稽核原因。取消與釋放房晚在同一交易完成；退款另進入 `refund_pending` 並重試。退款失敗不恢復 Reservation，
須在後台可見。

已 `expired` 或 `cancelled` 後才收到付款成功是 Late Payment。系統記錄後排入全額退款，不得復活 Reservation
或重新占用房晚；退款失敗須通知營運者。

任何提供可退款 Cancellation Policy 的 Release，只能選取通過 refund contract 的 Payment Provider。現有
ECPay adapter 必須實作並驗證退款，才能成為 Booking 的可退款 provider；目前回傳 `unsupported` 的實作不符合
本規格。外部 ECPay staging refund UAT 是該 provider 的 release gate。

Booking 擁有 confirmed、cancelled、payment-expiring 等事件到模板的 mapping 與文案；Base Notification 只
提供 durable record、排程、寄送、重試、delivery log 與 provider adapter。通知失敗不回滾 Reservation。

## 7. 跨產品組裝

共用 ReleaseDefinition、bootstrap、manifest 與 contract checks 移至 `packages/platform/release`；Base、
Commerce、Booking 的產品組裝分別位於 `packages/releases/`。既有 `packages/commerce/` 不因本規格搬移，Booking
產品模組位於 `packages/booking/`。

ReleaseDefinition 必須成為下列內容的單一邏輯建置來源：

- Backend modules、Extensions 與 Themes。
- HTTP adapter contributions。
- Admin route、navigation、permission 與 UI entry contributions。
- 產品設定 schema、預設設定檔名及 CLI contributions。
- Release identity 與 build manifest。

共用 root manifest 只包含 release identity、選取 key、版本與可序列化 metadata。`server`、`worker`、`admin`、
`cli` 等 target 由 package subpath 或等價的 target-specific projection 解析各自的 executable contribution；不能
把 Nest controller、React component、DB factory 與 provider implementation 放進所有 target 都會 import 的
同一個物件。Server／worker／CLI artifact 不得匯入 React 或 Admin source；Admin browser artifact 不得匯入
Nest、DB、migration、secret 或 provider implementation；worker 不得匯入 HTTP controller 與 Admin UI。

所有 contribution 在建置時選取。正式環境不動態安裝程式碼。Storefront 沿用既有 module page declaration 與
Theme renderer，缺少必要 renderer 時啟動失敗。REST 由 Booking HTTP adapter 將明確產品端點轉成 Command／Query；
不提供自動公開任意 Command 的通用 REST 端點。

Base、Commerce、Booking 產生分開的靜態 artifact。Booking backend、Worker 與 browser artifact 不得包含
Commerce implementation。共用 API host、Admin shell、CLI 與 build scripts 不得用 release id 判斷產品行為。

## 8. 相容性與遷移

- Commerce 保留資料、migration history、公開 Command／Query／Event、URL 與 `commerce.yaml`。
- Booking 使用 `booking.yaml` 並從乾淨資料庫開始；不提供 Commerce 資料轉 Booking 的遷移。
- 設定檔名與 schema 由 ReleaseDefinition 宣告，共用 CLI 不依產品 id 猜測。
- Payment Provider ABI 以 expand／migrate／contract 的短期過渡保持每個 Story 後 trunk 可建置；所有既有 consumer
  搬完後移除 Order 專用契約，不保留永久 fallback。
- Booking 對外發布前不背負自己的舊版相容層。

## 9. 驗收條件

1. Base、Commerce、Booking 三個 Release 的 module、Theme、Extension、HTTP 與 Admin contract checks 通過。
2. Booking 乾淨資料庫沒有 Commerce 資料表，backend 與 browser artifact 不包含 Commerce module。
3. Commerce 原有資料、設定、公開契約、migration 相容及整合測試保持通過。
4. 同一份 Mock Payment 與 ECPay adapter 可分別由 Commerce Order 與 Booking Reservation 使用；Booking 使用的
   provider 必須通過 refund contract，ECPay staging refund UAT 未完成時不得解除其 release gate。
5. 兩個併發請求競爭最後一間房時恰好一筆建立成功，另一筆得到可辨識的不可售結果。
6. Quote 被改價、政策改變或售完時不建立 Reservation，而是回傳新 Quote 或不可售結果。
7. 取消與到期釋放每一個 Room Night；退款失敗不恢復 Reservation。
8. Callback、取消、到期與 deferred-expiry extension 的併發測試產生可序列化且符合鎖取得順序的結果，沒有
   雙重確認、雙重釋放或死鎖。
9. 付款失敗後可建立新 Attempt；重送付款啟動不重複建立；兩筆 Attempt 都成功時只有第一筆確認 Reservation，
   第二筆成為可追蹤的 Excess Payment 並退款。
10. Late Payment 不確認 Reservation、不重新占房，且建立可追蹤的退款與營運通知。
11. Access Grant 只能單次兌換且會轉到乾淨 URL；匿名操作沒有有效 management session 時一律拒絕。通知、URL、
    資料庫與 log 不保存原始 management token。
12. Account link 只能來自 authenticated actor 或有效 management session 後的顯式 claim；client account id 與
    Email matching 都不能建立 ownership。
13. 多房訂房同時滿足 available units、總入住人數上限與每房至少一位成人，occupancy 與 inventory 不混用。
14. 缺少必要 Storefront renderer 或 Admin contribution 時，在建置或啟動階段拒絕並列出缺項。
15. Target import scan 證明 server／worker／CLI／Admin 各自不攜帶其他 target 的 executable code，Booking artifact
    同時不包含 Commerce implementation。
16. 個資匿名化不破壞必要的付款、退款與 audit 證據。
17. Repository 最終 gate `make verify` 通過；外部 ECPay UAT 與正式部署仍是獨立 release gate。

## 10. Out of Scope

- 多 Property 搜尋、跨館 Reservation、實體房號與排房。
- OTA／Channel Manager、動態定價、促銷規則、連住折扣、餐食方案與兒童價。
- 修改日期／Room Type／房數、部分日期取消或拆分 Reservation。
- 到店付款、人工匯款、訂金尾款與帳款催收。
- Check-in、check-out、no-show、清潔排班、門鎖、餐飲與會計。
- Booking 電子發票；未經第二產品證據，不抽 Commerce Customer、Invoice、Promotion、Pricing 或 Inventory。
- Commerce 與 Booking 同站、同資料庫或單一 runtime 切換產品。
- 正式環境動態安裝 plugin、Theme 或 module。

## 11. 測試與交付原則

純價格、日期與 policy 規則在 package unit boundary 驗證；module service 與 Command／Query 使用真 PostgreSQL
integration 驗證鎖定、交易、付款重試／雙重成功、到期、退款、Late／Excess Payment；HTTP 只驗證授權、CSRF、
Access Grant、management cookie、Account claim、rate limit
及 adapter contract；Admin 使用既有 jsdom 接縫，互動密集頁面另做瀏覽器檢查。

每個 Story 只跨一個 package boundary，並保持 trunk 可建置。跨 package ABI 使用短期 expand／migrate／contract
工作流，最後一個 consumer 遷移後立即移除 superseded path。實作 Story 先跑受影響的最低有用檢查，整合 checkpoint
與最終交付依根 `AGENTS.md` 執行 `make verify`。

本次只交付規劃文件，因此不執行應用測試或外部 provider 驗證；文件檢查與獨立規格審查結果記在執行計畫。
