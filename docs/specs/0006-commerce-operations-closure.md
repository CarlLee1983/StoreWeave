# Spec 0006 — 購物營運閉環

- 狀態：ready-for-agent
- 依賴：Spec 0001–0005
- 相關 ADR：0009（非同步付款與庫存預留）、0015（訂單金額）、0027（外部 callback）、0028（運費）、0029（shipping module）、0030（待付款）、0031（出貨階段）

## Problem Statement

目前系統已完成可驗證的購物主鏈：商品瀏覽、購物車、優惠、登入後結帳、台灣宅配地址、
庫存預留、付款嘗試與 ECPay 付款 callback。它還不是一個可由店家完整營運的交易閉環：
物流商尚未建單與回傳進度、超商尚未選店、已付款訂單沒有退款與退貨處理、訂單通知與
電子發票尚未接上，且部分關鍵操作只有 API，沒有後台介面。

本規格把「能下單」收斂成「能收款、出貨、追蹤、處理售後並留下正確帳務證據」。
不以某一間金流或物流商綁死核心；ECPay 是目前第一個付款 adapter，往後可以抽換。

## Current Baseline

下列不是本規格重做的範圍，而是後續票必須保留的既有能力：

- Cart 轉成 Order 時重驗價格、優惠與庫存，並凍結訂單與配送快照。
- Order 使用付款嘗試與 `pending`、`payment_processing`、`awaiting_payment`、`paid`、
  `cancelled`、`expired` 狀態；付款 callback 與 worker 共用同一條入帳路徑。
- ECPay payment adapter 支援信用卡、ATM、超商代碼與超商條碼，並驗證 CheckMacValue。
- Shipping module 保存商家配送方式、台灣宅配／門市取貨目的地，以及
  `created → shipped → arrived → completed` 的出貨領域階段。

## User Stories

1. 作為顧客，我在結帳時要先看到含運費的應付總額，才不會在送出後才知道價格。
2. 作為顧客，我付款失敗或待付款時要能安全地繼續付款；在尚未付款且尚未出貨時能取消訂單。
3. 作為店家，我要能以一個可抽換的物流 adapter 建立託運單、取得標籤與追蹤號碼，而不把物流商 API 寫進 Order。
4. 作為顧客，我要能選擇物流商提供的超商門市，且跨站回填不依賴 session cookie。
5. 作為店家，我要能在後台管理配送方式與出貨，並看到物流商參考號、追蹤號與失敗原因。
6. 作為顧客，我要收到下單、付款、出貨與到貨通知，並可從訂單頁看到配送進度。
7. 作為店家，我要能對已付款訂單執行可稽核的退款，並能找出金流端與本地付款紀錄的差異。
8. 作為顧客與客服，我要有退貨／換貨案件及其進度，而不是只能手工改訂單狀態。
9. 作為店家，我要能依已選定的電子發票服務處理統編、載具、開立、作廢與折讓。
10. 作為顧客，我要能搜尋、篩選與分頁瀏覽商品，不必只靠首頁固定清單。

## Scope and Decisions

### 1. Transaction boundary

- 外部付款、物流、發票與通知都必須經由 provider contract／adapter 呼叫；Order、Shipping
  與 Customer module 不得直接依賴特定商的 HTTP API。
- 所有對外建立、退款、查件與 callback 都要有 provider reference、冪等鍵、原始結果的稽核
  證據與可重試策略。外部呼叫不可包在長時間資料庫交易內。
- 任何支付成功、物流狀態或退款 callback 都先驗簽，再轉為系統 actor 的受控 command；重送不能
  造成重複扣庫、重複退款、重複通知或重複發票。

### 2. Payment and refund

- 「取消未付款訂單」與「退款已付款訂單」是不同流程。已付款訂單不能用取消假裝退款。
- 退款以退款紀錄為事實來源，記錄原付款嘗試、金額、原因、操作者、provider reference、
  requested／succeeded／failed 狀態與時間；須支援日後部分退款，但首個垂直切片可先限制整單退款。
- ECPay 的正式 capability、帳號設定與 sandbox／UAT 要先由 release ticket 驗證；不可假設目前
  checkout adapter 就具有可用的退款介面。確認的退款管道再由 adapter 實作。
- 付款對帳是比對本地 payment attempt 與金流商結果；差異只建立可處理的案件，不得靜默改寫已付訂單。

### 3. Fulfillment

- Shipping method 是店家維護的商業規則；carrier adapter 僅負責門市、建單、標籤、查件與 callback。
- 第一版一張 Order 對應一筆 shipment，沿用現有出貨階段；拆單、多包裹與跨倉出貨不在範圍。
- 門市選店用短效、單次、只可回填指定 Cart 的權杖；回填後仍須驗證店號、地址與 shipping method 的
  provider/type 相容。
- 物流商原始狀態碼保存在營運紀錄；對顧客與其他模組只發布標準 shipment stage。

### 4. Notifications and customer experience

- 訂單通知透過 NotificationProvider，通知內容只讀已凍結的訂單／shipment 資料；發送失敗可重試，
  不能回滾付款或出貨。
- 顧客訂單頁顯示付款續付、配送快照、追蹤號與標準進度，不顯示物流商祕密或原始 callback payload。
- 前台商品搜尋使用既有 catalog query 能力，不新增另一套搜尋索引；在資料量需要時另立票決定索引。

### 5. Invoice and compliance boundary

- 電子發票是獨立 provider boundary。實作前須由商家確認採用的服務商、開立時機、B2C／B2B 欄位、
  載具與捐贈需求；這些是外部營運決策，不能由程式猜測。
- 發票的開立、作廢、折讓必須連結訂單與退款紀錄並留稽核證據；發票 provider 失敗時不得讓已確認的
  付款或退款被回滾。

## Acceptance Criteria

本規格完成時應能在 staging 以真實供應商測到下列情境，並在自動化測試以 provider fake 覆蓋對應
失敗、重送與冪等情境：

1. 顧客結帳可看見含運費總額，建立訂單後能完成付款或安全重試／取消未付款訂單。
2. 店家可為已付款訂單建立託運單，取得標籤與追蹤號；物流 callback 可把 shipment 推進一次且不倒退。
3. 顧客可完成一次超商選店、在訂單頁看配送進度，並收到訂單、付款與出貨通知。
4. 後台可管理配送方式與出貨，能看到需處理的物流或通知失敗。
5. 退款、對帳、退貨／換貨、電子發票各有可稽核模型與操作入口；其外部服務結果可重放而不重複執行。
6. 商品搜尋／篩選／分頁在前台可用，且不改變既有商品、購物車與下單契約。

## Out of Scope

- 多包裹、拆單、跨倉與國際物流。
- 訂閱制、定期扣款、代收貨款、儲值或錢包。
- 商品評論、願望清單、推薦、SEO／廣告投放。
- 自建全文搜尋叢集、資料倉儲與會計總帳整合。

## Delivery Order

先完成上線閉環（結帳呈現、ECPay UAT、物流 adapter、後台出貨、追蹤與通知），再完成
售後與帳務（退款、退貨／換貨、電子發票），最後做不阻擋交付的商品探索優化。各項依賴與可獨立驗收
條件列在 Ticket 57–67。
