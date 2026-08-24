# 58 — ECPay 正式上線驗證與營運手冊

**What to build:** 把既有 ECPay checkout adapter 從「程式與 fake 測試通過」驗證到可上線的
staging／production 設定。這張票是 release gate，不以虛構的退款 capability 補齊功能。

**Blocked by:** 商家／ECPay sandbox 與 production UAT、帳約付款產品與 callback 網域確認

**Status:** implementation complete; external sandbox／production UAT pending

- [x] 以 secret provider 注入商店的 Merchant ID、Hash Key、Hash IV；不把機密寫入 YAML、log 或測試輸出
- [x] 驗證設定 schema、callback 驗簽／ack／冪等、整數 TWD、付款資訊期限與失敗處置的 repository 證據
- [x] 把部署設定、切換、監測、金鑰輪替與失敗回復寫入 [runbook](../runbooks/ecpay-release.md)
- [ ] 在 sandbox／UAT 逐一驗證信用卡、ATM、超商代碼、超商條碼與重送 callback
- [ ] 設定公開 HTTPS ReturnURL／PaymentInfoURL，驗證 ECPay 的 callback 能抵達、驗簽並回 `1|OK`
- [ ] 由商家確認 production 帳號、付款產品、callback 網域，並記錄 ECPay 實際可使用的退款／查詢產品能力

## 驗收

每種啟用付款方式都有一筆成功、失敗或逾期、以及重送 callback 的 UAT 證據；production 切換前由
商家確認帳號與 callback 網域。

目前 adapter 不實作退款，也不宣稱已具有 ECPay 主動查詢 API；這些能力的帳約／產品確認是 Ticket 64
的外部輸入，不可用 checkout fake 測試替代。
