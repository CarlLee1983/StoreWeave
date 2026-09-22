# 64 — ECPay 退款 Adapter 與付款對帳

**What to build:** 依 58 確認的 ECPay 正式產品能力，將 63 的退款請求送到正確的 ECPay 介面，
並建立本地付款嘗試與金流端結果的可處理對帳差異。不得在未確認帳號 capability 前猜測 API。

**Blocked by:** 58, 63

**Status:** closed under accepted risk without merchant UAT (2026-09-22; Carl Lee).

The merchant's enabled refund/query product, its contract, and UAT evidence from
58 remain unverified. This closure does not claim that the ECPay adapter,
reconciliation workflow, or a refundable release is production-ready; the
unchecked requirements below remain unimplemented and must be reopened if the
merchant enables ECPay refunds.

The provider-neutral refund worker seam is in place for the mock provider: it uses a platform refund-attempt reference for replay safety, keeps transport uncertainty in `requested`, and only records a provider-confirmed success. The ECPay extension remains refund-disabled by default and returns `unsupported` until an approved production configuration selects it; no merchant entitlement has been verified.

Before unblocking, record the ECPay product/endpoint, required request identifiers and signature, partial-refund and replay semantics, success/rejection/timeout responses, and the query/reconciliation contract. The UAT callback limitation alone is acceptable for development; the missing merchant refund capability is not.

- [ ] 在 ECPay provider 實作已確認的退款操作、簽章、冪等與結果解析；UAT 覆蓋成功、拒絕、timeout 與重送
- [ ] provider 成功才把退款標為 succeeded；失敗保留證據與可重試狀態
- [ ] 建立可排程或人工觸發的對帳，標示本地／金流狀態不一致的案件，不自動覆蓋帳務事實
- [ ] 後台可檢視、指派或結案差異，所有人工結論留下操作者與理由
- [ ] 補 fake-provider、integration 與 operator UI 測試

## 不做的事

- 未由 ECPay 帳約支援的自動退款方式、跨金流商合併對帳、會計總帳分錄。
