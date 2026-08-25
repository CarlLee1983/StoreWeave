# 66 — 台灣電子發票 Provider 與帳務流程

**What to build:** 先確認商家採用的電子發票服務商與營運規則，再以 provider boundary 接入統編、
載具、捐贈、開立、作廢與折讓。付款、退款與發票各自的外部結果不可互相回滾。

**Blocked by:** 63

**Status:** implemented and Stage UAT passed; production enablement remains a release configuration gate.

Do not select or infer an invoice-provider API from public documentation. Before implementation, the merchant must
confirm the provider and supply the B2C/B2B, carrier, donation, issuance, void, allowance, and post-refund rules
listed below, together with access to its test environment.

The merchant selected ECPay on 2026-08-25 and authorized use of ECPay's public Stage
test materials. This is sufficient to test an implemented ECPay adapter, but does not
choose the business rules below or grant access to a merchant production account. The
provider's test environment and public test fixture behavior are recorded in [ECPay
invoice research](../research/66-ecpay-invoice-stage-contract.md); no public test
credentials are copied into this repository.

On 2026-08-25, the merchant confirmed the first production rule set: **B2C only**;
issue after a successful payment; offer ECPay carrier, mobile barcode, natural-person
certificate, and donation choices at checkout; all prices include the 5% standard tax;
and void the invoice only after a **full** refund succeeds. Partial refunds are
deliberately not mapped to a void or allowance until the merchant approves that
separate policy. The implementation validates donation codes with ECPay before issue.

The core invoice lifecycle and ECPay adapter are implemented with durable issue/void
evidence, retry-safe references, a fake provider integration test, and a public ECPay
Stage UAT that verified love-code validation, issue, and void. The evidence and exact
Stage constraints are recorded in [the provider research note](../research/66-ecpay-invoice-stage-contract.md).

- [x] 在開發前記錄服務商、帳號／測試環境、開立時機、B2C／B2B 欄位、載具／捐贈與退款後處理規則
- [x] 發票資料與訂單／退款關聯，有 provider reference、狀態、稅額、時間與稽核資料
- [x] 在已確認的業務事件後非同步開立；失敗可重試並在後台可見，不能撤回已付款訂單
- [x] 全額退款後依確認的 provider 規則作廢；部分退款不送外部動作，重送 job 不重複開立
- [x] 顧客結帳與訂單頁只蒐集／顯示必要發票資訊；原始載具／捐贈資料留在受限發票快照，不進客戶訂單投影
- [x] fake provider、自動化整合測試與服務商測試環境 UAT 都通過

## 不做的事

- 自建稅務規則引擎、會計總帳與跨國 VAT。
