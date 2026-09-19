# Booking 規劃決策紀錄

- 日期：2026-09-19
- 狀態：Q1–Q44 已由使用者全部接受；安全與可驗證性細節經獨立審查補強。
- 正式規格：[Spec 0011](specs/0011-booking-product-release.md)
- 架構決策：[ADR 0052](adr/0052-booking-is-a-separate-product-release.md)

本文件保存 grilling 的決策來源，方便獨立檢查 Spec 是否完整。規格與 ADR 擁有正式契約；若摘要與正式文件
衝突，以後兩者為準。

| ID | 已接受的決策 |
| --- | --- |
| Q1 | 以一個真實 Booking Release 驗證復用，不先設計抽象多產品模板。 |
| Q2 | Booking 是獨立 Product Release，沿用 Platform／Base 並替換產品模組組合，不是 Commerce 模式。 |
| Q3 | 能力須有至少兩個語意與生命週期一致的實際產品 consumer 才升格 Base。 |
| Q4 | Commerce 與 Booking 分開建置、部署並使用資料庫；第一階段不做同站共存。 |
| Q5 | 第一版採 Room Type 數量庫存，不在訂房時指定實體房號。 |
| Q6 | 首個切片走完搜尋、Quote、房晚保留、Reservation、付款、確認、取消與後台；OTA 等另案。 |
| Q7 | Property 是正式領域物件，但第一版一個 Release 只啟用一個 Property。 |
| Q8 | 一筆 Reservation 只含一個 Room Type、連續日期及一個或多個可售單位。 |
| Q9 | Booker 不必登入；Booker、Guest 與 Account 是不同概念。 |
| Q10 | 入住日包含、退房日不包含；日期以 Property 時區解讀，pending／confirmed 占房晚。 |
| Q11 | 不另建 Hold aggregate；`pending_payment` Reservation 本身持有有期限的房晚占用。 |
| Q12 | 第一版只有基本每晚價格與指定日期覆寫；人數只驗證入住上限。 |
| Q13 | 先共用領域中立 Payment Provider adapter，付款資料與狀態仍由各產品擁有。 |
| Q14 | 第一版只整筆取消；政策截止前自助全額退款，截止後由營運者處理。 |
| Q15 | Booking 先切 `booking-property`、`booking-availability`、`booking-reservation` 三個 Product Module。 |
| Q16 | Booking 擁有房型事實與 Media reference；Base Media 擁有檔案，Content 只擁有編輯內容。 |
| Q17 | 取消與釋放房晚同交易立即完成；退款獨立重試，失敗不恢復 Reservation。 |
| Q18 | Late Payment 不復活 Reservation，記錄後進入全額退款。 |
| Q19 | Quote 帶 fingerprint；價格、政策或供應改變時拒絕舊 Quote 並要求重新確認。 |
| Q20 | 互動式 Booking 後台採 build-time Admin contribution，不以 operator SSR 頁替代完整後台。 |
| Q21 | Storefront 沿用 module page declaration 與 Theme renderer；REST 由明確 Booking adapter 提供。 |
| Q22 | 第一版只有 pending、confirmed、expired、cancelled 契約狀態；住宿階段由日期推導。 |
| Q23 | 匿名管理使用可撤銷的隨機憑證；獨立審查後收斂為 Email 單次 Access Grant 兌換 cookie 中的 management token，避免永久 bearer token 被通知系統保存。 |
| Q24 | 只保存主要 Guest、成人／兒童數、Booker 聯絡資料與選填備註，不收完整同行者證件。 |
| Q25 | 第一版只支援 Provider 可驗證結果的即時或延後付款，不做人工匯款或到店付款。 |
| Q26 | 營運者整筆取消時可指定零至實收金額的退款與原因，不支援部分日期或房數取消。 |
| Q27 | Booking 擁有通知觸發、模板與文案；Base Notification 只負責 durable delivery。 |
| Q28 | Booking config 必須提供 PII retention policy，到期後匿名化非必要 Booker／Guest 資料。 |
| Q29 | Availability 逐房晚保存並依日期固定順序鎖列，所有晚都有供應才原子占用。 |
| Q30 | 正式分類為 Platform mechanism、Base Module、Product Module、Extension、Theme；避免含糊的 Core。 |
| Q31 | 共用 Release 機制移到 platform package，產品組裝分開；不為整齊搬移既有 Commerce modules。 |
| Q32 | ReleaseDefinition 是所有 build target 的單一邏輯組裝來源；獨立審查後補上 target-specific projection，避免跨 target code contamination。 |
| Q33 | Commerce 保留 `commerce.yaml`，Booking 使用 `booking.yaml`；名稱與 schema 由 ReleaseDefinition 宣告。 |
| Q34 | Payment Provider ABI 改收 reference、displayReference、amount、currency、method，移除 Order 欄位。 |
| Q35 | 第一版每個 Property 單一幣別、整數最小單位、含稅且無服務費；電子發票另案。 |
| Q36 | 日期、Room Type、房數不原地修改；取消後依當下供應與價格重訂。 |
| Q37 | 預設最遠 365 天、最長 30 晚、一般 pending 15 分鐘；延後付款可採 Provider 期限。 |
| Q38 | 先建立 Spec 0011，再按 package boundary 拆 Story，不直接預造實作任務。 |
| Q39 | 依 Release → contributions → Payment ABI → Booking modules → UI → closure 的垂直切片落地。 |
| Q40 | 保持 Commerce 資料、migration、公開契約、URL 與設定相容；Booking 不轉換 Commerce 資料。 |
| Q41 | Base、Commerce、Booking 各自產生 build-time 靜態 artifact，不做 runtime product switch。 |
| Q42 | 跨產品完成須有三種 Release、artifact／DB 隔離、付款共用、併發與完整 repository gate 證據。 |
| Q43 | 只抽 Booking 真正撞到的 Release、HTTP／Admin contribution 與 Payment Provider 接縫。 |
| Q44 | 上述內容構成 shared understanding；本輪只產出規劃文件，不開始實作。 |

## 獨立審查補強

下列項目是已接受決策的安全或可驗證性細化，沒有擴大產品範圍：

- Reservation Payment Attempt 定義狀態、重試、啟動冪等與唯一 winning attempt；第二筆成功收款是 Excess Payment。
- Callback、取消、到期與付款期限延長以 Reservation row lock 序列化，再鎖 Attempt，最後才鎖 Room Night。
- 可退款 Booking Provider 必須通過 refund contract；現有回傳 `unsupported` 的 ECPay 不符合 release gate。
- Account linkage 只能來自 authenticated actor 或 token-backed explicit claim，不接受 client account id 或 Email match。
- Room Type 使用 `max_occupancy_per_unit`，Room Night 使用 sellable／reserved units，分開入住人數與房數維度。
- Release root manifest 只保存 metadata，各 target 透過自己的 projection 載入 executable contributions。
