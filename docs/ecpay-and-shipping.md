# 綠界付款與台灣配送設定

這個 release 已編入 `ecpay` 付款 Extension 與獨立的 shipping module。付款 Provider 可由設定抽換；
運費與配送方式則由商家維護，並在結帳時凍結到訂單，不會因日後改價或停用而改寫歷史訂單。

## 啟用綠界

在 `commerce.yaml` 啟用 `ecpay`。建議把兩種綠界 server callback 都指向平台的泛用路徑
`POST /callbacks/payment/ecpay`；若由 ingress 轉寫路徑，必須在 sandbox／UAT 證明最終仍會到達
這條 route：

```yaml
extensions:
  - id: ecpay
    enabled: true
    config:
      environment: stage # 上線時改 production
      returnUrl: https://shop.example.com/callbacks/payment/ecpay
      paymentInfoUrl: https://shop.example.com/callbacks/payment/ecpay
      clientBackUrl: https://shop.example.com/account/orders
      enabledMethods: [card, atm, cvs_code, cvs_barcode]
      itemName: StoreWeave order
      tradeDescription: StoreWeave payment
```

啟用 `ecpay` 時，請停用或移除範例用的 `mock-payment` Extension，讓綠界成為店家的預設付款 Provider。
只提供信用卡時可省略 `paymentInfoUrl`；只要啟用 ATM、超商代碼或超商條碼付款，就必須設定它，因為該
回呼負責保存繳費帳號／條碼與其到期時間。

Secret provider 必須提供下列三個值，不能放在 YAML：

```text
ECPAY_MERCHANT_ID=...
ECPAY_HASH_KEY=...
ECPAY_HASH_IV=...
```

付款是在背景工作啟動；訂單頁拿到綠界導轉資料後會顯示「前往付款」按鈕。綠界回呼先由
Provider 驗證 CheckMacValue，驗證成功後才以同一筆付款嘗試更新訂單。重送回呼不會重複扣庫存或入帳；
平台在可持久化接受 callback 後才回 `1|OK`。callback 本身不帶 API token，須以公開 HTTPS 網域讓
ECPay 可達，並受到來源 IP rate limit 保護。

綠界 AIO 只接受整數 TWD；因此送往綠界的訂單總額必須是整元（目前的 money cents 值須可被 `100` 整除）。
`returnUrl`、`paymentInfoUrl` 與 `clientBackUrl` 必須是 HTTPS URL，且不能包含 URL credentials 或 fragment；
兩個 server callback 也不能有 query parameter。`clientBackUrl` 只是顧客返回連結，不能作為付款成功證據。
`enabledMethods` 不可重複。

完整的設定、sandbox／production UAT、金鑰輪替、回復與故障處置見
[ECPay Checkout 上線 Runbook](runbooks/ecpay-release.md)。目前 checkout adapter **沒有**實作退款或
已確認的主動查詢 API，請勿在營運流程假設這些能力。

## 綠界物流 adapter（UAT gate）

`ecpay-logistics` 是獨立於付款的 shipping extension；它訂閱本地 shipment 建立事件，將建單放進可重試的背景工作，並只透過 provider contract 回寫 provider reference、追蹤號和不含 URL／憑證的標籤列印參照。它不會讓 Order 或 Shipping module 依賴綠界 HTTP 格式。

```yaml
extensions:
  - id: ecpay-logistics
    enabled: true
    config:
      environment: stage
      mode: external_gate # 預設；明確阻擋真實物流呼叫
      homeDeliveryServiceTypes: [home_delivery]
      statusQueryIntervalMinutes: 30
      statusQueryBatchSize: 100
```

Secret provider 必須提供獨立的物流 secret 名稱，不能放在 YAML：

```text
ECPAY_LOGISTICS_MERCHANT_ID=...
ECPAY_LOGISTICS_HASH_KEY=...
ECPAY_LOGISTICS_HASH_IV=...
```

`mode: fake` 僅供 repository test 使用，會建立 deterministic fake 託運單、模擬「遠端已成功但回應 timeout」的重試調和，並支援可設定的主動查詢階段；production 設定會拒絕 fake mode。`external_gate` 的 health check 會回不健康，且不進行網路呼叫——目前 adapter 沒有猜測任何未經 UAT 證實的建立／列印／查詢 endpoint 或欄位。

主動查詢每 `statusQueryIntervalMinutes` 分鐘掃描一次已建單、尚未完成的 shipment，依固定 key cursor 公平地分批排入可重試 job。查詢 job 只讀取 provider reference、平台 reference 與追蹤號，絕不讀取收件地址；carrier raw status 僅保存在 Shipping 的私有 operational evidence，audit 只保留 provider 與已映射的領域階段。延遲或亂序的查詢回覆不會讓 shipment 降階或進入死信。這條輪詢路徑不需要 callback，適合開發與 callback 不可達的環境；真實 ECPay 查詢仍待商家確認契約後解除 transport gate。

在實作真實 transport 前，商家必須確認所選綠界物流契約與啟用的宅配子服務、stage／production 帳號與對應金鑰、必要的帳戶餘額與測試標籤核准，以及瀏覽器列印流程是否可受控地轉成可下載檔案。若另外啟用 provider callback，才需確認可達的 HTTPS callback。標籤 API 目前只回授權後台可讀、`Cache-Control: no-store` 的 opaque reference；它不是可直接下載的綠界 URL。完整來源與未決項目見 [Ticket 59 官方研究](research/59-ecpay-logistics-official-api-research.md)。

## 設定台灣宅配方式

先用具有 `shipping:write` 的 API token 建立商家配送方式；費率與免運門檻由此設定，而不是向物流商即時詢價：

```http
POST /api/v1/shipping/methods
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "code": "taiwan-home",
  "name": "台灣宅配",
  "provider": "manual",
  "type": "home_delivery",
  "destinationKind": "taiwan_home",
  "feeCents": 6000,
  "freeShippingThresholdCents": 100000,
  "enabled": true
}
```

結帳頁會要求收件人、電話、郵遞區號、縣市、鄉鎮市區與地址，並可預填會員資料中的台灣地址。
每筆訂單保存的是配送方式名稱、費率結果與地址快照；停用這個方式只會讓新結帳看不到它，不影響既有訂單。

超商取貨的選店流程已經完成，不再只是資料模型。結帳頁的「選擇門市」會走
`POST /checkout/pickup/start` → 物流商的選店頁 → `POST /checkout/pickup/callback`
把門市寫回購物車；因為回傳是跨站 POST、身上沒有任何 cookie，中間靠一張短期單次的
**選店回填權杖**認出要寫回哪一台購物車（詞彙見 `CONTEXT.md`）。沒有真實物流商時，
`ecpay-logistics` 的 `mode: fake` 會提供一份假門市清單，選店流程照樣走得完。

主動查詢由 `ecpay-logistics` 的 recurring job 依 `statusQueryIntervalMinutes` 註冊到平台排程器；它只負責
排入可重試工作，實際執行仍走共用 Worker。真實 ECPay 查詢 transport 仍須等商家確認契約並完成 UAT，
`external_gate` 不會因此對外發送未授權請求。
