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

取貨門市的資料模型也已支援 `pickup_store`，但門市搜尋／選店 UI 與特定物流商 Extension 是後續可獨立加入的切片。
目前 shipping module 保存配送方式、台灣地址與出貨階段；實際建立託運單／查詢物流進度時，再加上對應物流商
Extension（例如綠界物流或宅配業者）即可，不必改寫結帳或訂單資料。
