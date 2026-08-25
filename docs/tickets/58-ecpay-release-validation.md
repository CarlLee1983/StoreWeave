# 58 — ECPay 正式上線驗證與營運手冊

**What to build:** 把既有 ECPay checkout adapter 從「程式與 fake 測試通過」驗證到可上線的
staging／production 設定。這張票是 release gate，不以虛構的退款 capability 補齊功能。

**Blocked by:** 商家／ECPay sandbox 與 production UAT、帳約付款產品與 callback 網域確認

**Status:** callback receiver implementation complete and locally verified; public-domain／merchant production UAT is a deployment-release check, not a code blocker.

The provider's actual signed forms were accepted by ECPay Stage for all four supported
`ChoosePayment` values on 2026-08-25. A separate public-fixture `card` transaction
also reached a temporary StoreWeave HTTPS callback, received `1|OK`, and marked its
synthetic order paid. This is still not merchant UAT: it does not cover failures,
expiry, deferred methods, an ECPay-originated retry, or production. See [Stage
checkout smoke evidence](../research/58-ecpay-stage-checkout-smoke.md).

On 2026-08-25, the merchant confirmed that no public callback domain is currently
available. Public ECPay Stage fixtures remain authorized for testing. StoreWeave still
implements the complete callback receiver now: it retains the exact raw form bytes for
provider verification, dispatches only the provider-normalized result through the
order state machine with an opaque idempotency key, and returns the provider's plain
text acknowledgement. A stable public HTTPS endpoint is required only to verify
deployment ingress, provider-originated retries, and merchant production settings; it
does not block this implementation. A temporary tunnel is not a substitute for the
production callback domain.

- [x] 以 secret provider 注入商店的 Merchant ID、Hash Key、Hash IV；不把機密寫入 YAML、log 或測試輸出
- [x] 驗證設定 schema、callback 驗簽／ack／冪等、整數 TWD、付款資訊期限與失敗處置的 repository 證據
- [x] 把部署設定、切換、監測、金鑰輪替與失敗回復寫入 [runbook](../runbooks/ecpay-release.md)
- [x] 接收 `POST /callbacks/payment/ecpay` 的原始表單、驗簽、寫入付款狀態、冪等處理並回覆 `1|OK`；以 HTTP 與 controller 測試驗證
- [ ] 在部署前以公開 HTTPS 網域逐一驗證信用卡、ATM、超商代碼、超商條碼、失敗／逾期與 provider-originated retry
- [ ] 上線前由商家確認 production 帳號、付款產品與 callback 網域；退款／查詢產品能力仍屬 Ticket 64 的外部輸入

## 驗收

程式驗收：已接收、驗簽、冪等寫入並正確回覆 callback。部署驗收：每種啟用付款方式都有一筆成功、
失敗或逾期、以及重送 callback 的公開 HTTPS UAT 證據；production 切換前由商家確認帳號與 callback
網域。

目前 adapter 不實作退款，也不宣稱已具有 ECPay 主動查詢 API；這些能力的帳約／產品確認是 Ticket 64
的外部輸入，不可用 checkout fake 測試替代。
