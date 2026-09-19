# 0052. Booking 是獨立 Product Release，共用能力以第二個實際產品驗證

- 狀態：accepted
- 日期：2026-09-19

StoreWeave 的第二個完整產品以住宿預訂 Booking Release 驗證跨產品復用。Booking 不把 Commerce 切換成
「訂房模式」，也不把商品、Cart、Order 與庫存抽象成同一組萬用交易型別；它與 Commerce 分開建置、部署並
使用資料庫，沿用領域中立的 Platform 與已證明適用的 Base Module，再組入自己的 Product Module、Theme、
HTTP adapter、Admin contribution 與 Extension。

第一批 Booking Product Module 是 `booking-property`、`booking-availability` 與 `booking-reservation`。
Property 擁有住宿地點與房型事實；Availability 擁有逐房晚的供應、價格、Quote 與原子占用；Reservation 擁有
Booker／Guest 快照、付款嘗試、取消、退款與到期。第一版一筆 Reservation 只包含一個 Room Type 與一段連續
日期，不要求 Booker 登入，也不支援改期、部分日期取消、到店付款、人工匯款、實體房號分配或入住作業狀態。

能力不因不同產品使用相同名詞就提升到 Base。只有至少兩個實際產品中的領域語意、生命週期與公開契約一致時
才升格；在證據出現前，各產品保留自己的持久化模型與狀態轉換。付款因此只先共用領域中立的 Provider adapter，
Commerce Order 與 Booking Reservation 各自擁有付款嘗試及成功後效果。Provider ABI 以 `reference` 與
`displayReference` 取代 Order 專用欄位，並同步升版既有金流 Extension；這不建立共用 Payment Module。

共用 ReleaseDefinition 與 bootstrap 從產品組裝中分離，並成為 backend modules、Extensions、Themes、HTTP、
Admin、CLI 與設定定義的單一邏輯來源。各 build target 使用獨立 projection／package subpath，共用 manifest
只帶 key 與 metadata，不能讓 server／worker／CLI 載入 React，也不能讓 Admin browser 載入 DB、Nest 或 provider
實作。產品貢獻一律在建置時選入；本決策不改 ADR 0002，不支援正式環境動態安裝程式碼。既有 Commerce 保留
`commerce.yaml` 與公開契約，Booking 使用自己的設定與命名空間。

## 後果

- Booking 是 Base 可復用性的第二個完整證據；若新增 Booking 必須在 Platform 加產品名稱判斷，驗證即失敗。
- Admin 需要建置期 contribution 契約，現有 Commerce route table 可分批遷移，但完成後不得有兩個組裝來源。
- Booking Theme 可依賴 Booking page types；Platform 與 Base 不得反向依賴 Booking。
- 逐房晚供應以固定順序鎖列，Reservation 狀態與房晚占用在同一交易完成；取消立即釋放房晚，退款獨立重試。
- 遲到的成功付款不復活已取消或過期的 Reservation，而是記錄並進入全額退款。
- 同一 Reservation 的付款 callback、取消、到期與期限延長以 Reservation row lock 序列化；第二筆成功收款是
  Excess Payment，記錄後全額退款，不改變 Reservation。

## Falsified if

若 `packages/booking/` 必須匯入 Commerce Order、Cart、Customer 或 Inventory 才能完成核心旅程，或
`packages/platform/release/` 與其他 Platform／Base package 出現 `commerce`／`booking` 的產品分支，或
`packages/platform/extension-sdk/src/providers.ts` 的 Payment Provider 再次要求某個產品 aggregate 欄位，或
`packages/releases/booking/` 不能單靠 ReleaseDefinition 的 target projections 組裝各 artifact，則本決策宣稱的
產品邊界與 Base 可復用性被推翻，必須重開。
