# ECPay Checkout 上線 Runbook

本手冊是 Ticket 58 的 release gate。它只描述目前 checkout adapter 與平台能在 repository
中證明的行為；**不會連到 ECPay、建立付款、也不會把 sandbox 結果當作已完成。**

相關設定範例見 [ECPay 與配送設定](../ecpay-and-shipping.md)，一般部署流程見
[Docker](../deployment-docker.md) 與 [原生 Linux](../deployment-native.md)。

## 工作契約與完成定義

目的：在 staging 與 production 使用已核發、各自隔離的 ECPay 帳號與公開 HTTPS 網域，安全地啟用
`ecpay` checkout。所有已啟用付款方式都必須留下成功、失敗或逾期、以及 callback 重送的 UAT 證據。

不可把以下項目誤列為完成：

- `commerce doctor` 或 `/health/dependencies` 通過，不代表可連到 ECPay，也不代表 ECPay 已接受
  callback URL；ECPay provider 的 health 是 **offline/config only**。
- checkout adapter 目前沒有實作退款，也沒有已確認的 ECPay 主動查詢／對帳 API。不得假設任何
  退款、查單、補單或供應商重試頻率；確認帳約與產品能力後由後續 Ticket 63／64 實作。
- stage 與 production 只能各自完成外部 UAT，不能以本文件或 fake test 取代。

## Repository 內可驗證證據

| 項目 | 已有行為／證據 | 營運含義 |
| --- | --- | --- |
| Secrets | extension 宣告 `ECPAY_MERCHANT_ID`、`ECPAY_HASH_KEY`、`ECPAY_HASH_IV` 為必要 secret，Extension Host 與 `commerce doctor` 只檢查存在、不輸出值。 | 只由設定的 Secret Provider（env 或受保護的 secret file）供應；不可放進 YAML、shell history、log、測試輸出或工單附件。 |
| URL 設定 | `returnUrl`、延遲付款需要的 `paymentInfoUrl`、以及可選的 `clientBackUrl` 都會驗證為 HTTPS URL，拒絕 URL credentials 與 fragment；兩個 server callback 另拒絕 query parameter。 | 建議兩個 server callback 使用 `https://<public-host>/callbacks/payment/ecpay`；設定不強制固定 path，若 ingress 轉寫，必須在 UAT 證明最後仍到達此平台 route。 |
| 方法與金額 | `card`、`atm`、`cvs_code`、`cvs_barcode` 映射為 ECPay `Credit`、`ATM`、`CVS`、`BARCODE`。只接受正整數 TWD（`amountCents % 100 === 0`），並拒絕重複 method。 | 僅列出帳約已開通且已完成該方法 UAT 的 methods；ATM／超商代碼／超商條碼缺 `paymentInfoUrl` 時設定會被拒絕。 |
| Callback | 平台接受 `POST /callbacks/payment/ecpay`，以原始 form body 交給 provider 驗簽 CheckMacValue、MerchantID、付款嘗試與可選金額，再走一般付款結果 command。 | callback route 不需 API token，但不等於信任來源；未驗簽 payload 不會入帳，且原始 payload／CheckMacValue 不應寫進 log。 |
| Ack 與重送 | 事件在平台可接受後才回 ECPay 的 `200`／`1|OK`；無法驗證或保存時回 `500`／`0|FAIL`。callback 結果以穩定 idempotency key 處理，重送不應重複入帳或扣庫。 | 保留每個方法的首次與重送 callback evidence，並確認觀察到 `1|OK`。不要宣稱或依賴未確認的 ECPay retry cadence。 |
| 防護與診斷 | callback 未帶 token，但有每來源 IP 300 次／分鐘的 POST rate limit；`commerce doctor` 檢查 secret、extension 相容性及一般依賴。`/health/dependencies` 需 bearer token。 | 反向代理必須正確傳遞 client IP 並依部署設定 `http.trustProxy`；監控 callback 429／5xx 與拒絕 callback 的日誌。 |

## 上線前設定（各環境各做一次）

1. 由商家／ECPay 確認該環境的 Merchant ID、可用付款產品、sandbox 或 production 帳號歸屬，及允許的
   callback 網域。這是外部 gate，repository 無法證明。
2. 在該環境的 Secret Provider 設定三個名稱相同、值不同的 ECPay secrets。確認檔案型 provider 的
   secret file 權限受限；不要用 `echo`、`printenv` 或 verbose debug 驗證值。
3. 在 `commerce.yaml` 啟用 `ecpay`，移除或停用店家預設付款位置的 `mock-payment`；設定環境、公開 HTTPS
   URL、已核准 methods、商品名稱與交易說明。`ReturnURL` 與 `PaymentInfoURL` 是 server callback，
   `ClientBackURL` 僅是顧客返回連結，不能當付款成功依據。
4. 將 public hostname 的 TLS、DNS、反向代理與 `http.publicUrl`／`http.trustProxy` 一起驗證。從網際網路
   可達的 ingress 必須把 `POST /callbacks/payment/ecpay` 正確交給 API；不能只在內網或 localhost 成功。
5. 用受控管理 token 執行 `commerce doctor`，確認 `secret present`、extension compatibility 與一般依賴。
   以同一 token 呼叫 `/health/dependencies`，確認存在
   `provider:payment:ecpay`；其「offline configuration verified、upstream connectivity and callback delivery
   require UAT」結果僅證明離線設定，不能測 ECPay reachability。

範例（名稱而非真實值）：

```yaml
extensions:
  - id: ecpay
    enabled: true
    config:
      environment: stage
      returnUrl: https://shop-staging.example.com/callbacks/payment/ecpay
      paymentInfoUrl: https://shop-staging.example.com/callbacks/payment/ecpay
      clientBackUrl: https://shop-staging.example.com/account/orders
      enabledMethods: [card, atm, cvs_code, cvs_barcode]
```

## Sandbox／UAT 證據表（外部 gate）

在帳約允許的每一種方法填一列；資料放在受控的 release evidence 位置，不包含 Hash Key、Hash IV、
完整 callback body 或 CheckMacValue。

| 方法 | 成功付款 | 失敗或逾期 | PaymentInfo（延遲方法） | 重送 callback | 證據／操作者／時間 |
| --- | --- | --- | --- | --- | --- |
| card | [ ] | [ ] | n/a | [ ] | |
| atm | [ ] | [ ] | [ ] 帳號與期限可見 | [ ] | |
| cvs_code | [ ] | [ ] | [ ] 代碼與期限可見 | [ ] | |
| cvs_barcode | [ ] | [ ] | [ ] 條碼與期限可見 | [ ] | |

每次驗證均要確認：送出的總額是整數 TWD；訂單頁只顯示可公開的付款資訊；callback 的成功、失敗與
重送沒有產生第二次付款結果、庫存異動或通知。若某方法未被帳約開通，從 `enabledMethods` 移除它並把
商家確認記為 gate，不可把未測的 method 帶進 production。

## 切換、回復與金鑰輪替

1. 先在隔離的 staging 資料庫完成上述 UAT，再以 production 帳號、production URL 與 production
   Secret Provider 重做必要 UAT。**不可在同一個資料庫把尚有未結束 attempts 的 stage 設定原地切成
   production**；它會混淆 trade reference、callback 簽章與營運證據。
2. production 切換前建立資料庫與設定備份，確認 API 與 worker 都使用同一份 extension 設定與 secrets。
   部署後先跑 doctor、授權的 dependencies health，然後才開放 checkout；兩者都只是內部驗證。
3. Merchant／Hash Key／Hash IV 輪替時，依 ECPay 的實際並行／生效規則安排維護窗口。更新 Secret Provider
   後要讓 **API 和 worker 一起重啟**，避免兩個 process 使用不同 key。先保留足以處理既有 attempts 的
   受控回復方案；本 adapter 不支援同時以兩組 ECPay key 驗簽。
4. 若新設定或 callback UAT 失敗，立即停止對該 provider 建立新 checkout，回復最後已驗證的設定與
   secrets，並同步重啟 API／worker。不要靠直接改寫 order 為 paid 或假造 `1|OK` 回應修復。

## 事件處置與升級路徑

- **callback 401／404／TLS/DNS 問題：** 檢查 public ingress、path rewrite、method（POST）、憑證鏈與
  ECPay 後台的 URL；callback endpoint 不要求 token，因此 401 通常表示 proxy 或路由設定錯誤。
- **429：** rate limiter 以來源 IP 為單位。確認 proxy client-IP 設定與尖峰量，保留 request metadata 與
  correlation ID；不要為了單一 callback 關掉 rate limit。ECPay 是否、何時重送需向其實際產品文件／支援確認。
- **`0|FAIL`、驗簽或 amount／MerchantID 不符：** 不要重送未驗簽 payload 到內部 command，也不要記錄原文。
  查設定版本、secret rotation 時間與 attempt reference，修正後由 ECPay／商家依已確認流程重送或重建付款。
- **late confirmation、逾期或不一致：** 建立營運案件，保留已遮蔽的 attempt reference、provider reference、
  時間與狀態變化。不得自動認定為退款或靜默改 paid；目前未實作退款與主動查詢 API，須依帳約確認後的
  人工／後續對帳流程處理。
- **失敗訊息或 callback 拒絕增加：** 以 correlation ID 串 API／worker log，檢查 `commerce doctor`、
  授權的 dependencies health、outbox、job queue 與 worker heartbeat。若 provider health 為 pass，仍需
  把它視為設定存在，另從 UAT 或 ECPay 管道確認外部狀態。

## Production sign-off

- [ ] 商家確認 production Merchant ID、付款產品、callback 網域與責任人。
- [ ] public HTTPS callback 經真實 ECPay UAT 到達、驗簽且收到 `1|OK`。
- [ ] 每個啟用 method 的成功、失敗／逾期與重送證據完整。
- [ ] API／worker 使用相同已驗證設定；secret rotation、rollback 與聯絡流程已有值班人員確認。
- [ ] 退款與主動查詢 capability 的帳約結果已記錄；在後續 adapter 上線前，不對顧客承諾自動退款或查單。
