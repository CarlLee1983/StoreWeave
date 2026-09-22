# ECPay credit-card refund and reconciliation contract research

**Accessed:** 2026-09-22. **Scope:** the public ECPay documentation for the
all-in-one-payment credit-card refund operation and its directly linked credit-card
detail query. No credentials, customer data, merchant-console data, or live request
was used.

## Short conclusion

The public contract establishes a production-only, form-encoded credit-card
post-authorisation operation, plus a production-only detail query that can support
reconciliation. It is sufficient to model request signing, provider identifiers,
provider-confirmed success, and an ``unknown`` outcome after a transport timeout. It
does **not** establish that StoreWeave's merchant has this product enabled, an
idempotency/replay guarantee, usable Stage refund tests, or the merchant's actual
refund policy; those remain account-specific UAT decisions.

## Provider facts established by the public documents

### Product, endpoint, and request contract

- The product is ECPay **全方位金流 API**'s **信用卡請退款功能**. The operation page
  does not publish a versioned path or an API-version number. Its OpenAPI excerpt is
  therefore not a basis for inventing one. [Refund operation](https://developers.ecpay.com.tw/2885/)
- The documented production refund endpoint is `POST
  https://payment.ecpay.com.tw/CreditDetail/DoAction` with
  `application/x-www-form-urlencoded`. The same page explicitly says its test
  environment cannot provide real authorisation and this API cannot be used there.
  [Refund operation](https://developers.ecpay.com.tw/2885/)
- Required refund-operation fields are `MerchantID`, original `MerchantTradeNo`,
  ECPay `TradeNo`, `Action`, `TotalAmount`, and `CheckMacValue`; `PlatformID` is
  optional and applies to project partner platforms. ECPay expressly tells merchants
  to retain the relation between `TradeNo` and `MerchantTradeNo`.
  [Refund operation](https://developers.ecpay.com.tw/2885/)
- The public signing contract is `CheckMacValue`, not an encrypted payload: sort all
  transmitted fields except `CheckMacValue`, surround the joined fields with
  `HashKey`/`HashIV`, URL-encode, lowercase, SHA-256, then uppercase the digest.
  Keys and IV are secrets and must not be logged or committed. [CheckMacValue appendix](https://developers.ecpay.com.tw/2902/)
- The refund response contains `MerchantID`, `MerchantTradeNo`, `TradeNo`, `RtnCode`,
  and `RtnMsg`; `RtnCode=1` is success and every other documented value is failure.
  The operation page does not document a response `CheckMacValue` or a response
  encryption layer, so a client must not claim cryptographic validation of this
  response without a superseding merchant contract. [Refund operation](https://developers.ecpay.com.tw/2885/)

### Permitted actions and amount constraints

- `Action=C` is close/charge, `R` is refund, `E` is cancel-close, and `N` is abandon.
  The documented refund procedure requires querying the order first and evaluating
  the latest positive `close_data.amount`. [Refund operation](https://developers.ecpay.com.tw/2885/)
- At **authorised**, `N` releases the held credit limit. At **pending close**, a full
  refund is `E` then `N`, while a partial refund is `R`. At **closed**, use `R`; at
  **operation cancelled**, use `N`. This is a state-dependent procedure, not a
  generic refund call. [Refund operation](https://developers.ecpay.com.tw/2885/)
- A refund cannot exceed the order amount. Instalment and bonus-redemption
  transactions must be fully refunded; only ordinary authorisations may be partially
  refunded. ECPay also documents merchant ECPay-account balance as a prerequisite for
  a refund to succeed. [Refund operation](https://developers.ecpay.com.tw/2885/)

### Query and reconciliation

- The linked **信用卡單筆明細查詢** API is versioned in its path as
  `POST https://payment.ecpay.com.tw/CreditDetail/QueryTrade/V2`; its included OpenAPI
  metadata calls this `1.0.0`. It too is production-only because real authorisation is
  unavailable in test. [Credit-card detail query](https://developers.ecpay.com.tw/2894/)
- Required query fields are `MerchantID`, `CreditRefundId` (the credit-card
  authorisation number), `CreditAmount`, `CreditCheckCode`, and `CheckMacValue`.
  `CreditRefundId` may be obtained as `gwsr` from the payment result notification when
  the original order set `NeedExtraPaidInfo=Y`; the merchant back office has
  `CreditCheckCode`. [Credit-card detail query](https://developers.ecpay.com.tw/2894/)
- A successful query has empty `RtnMsg` and a nonempty `RtnValue`; documented query
  failure messages include `error_Stop`, `error_nopay`, and `error`. `RtnValue`
  provides the authorisation/order amount, closed amount, overall status, and
  `close_data` entries containing state, amount, serial number, and timestamp.
  These fields support a scheduled or manual comparison with a locally persisted
  payment/refund record. [Credit-card detail query](https://developers.ecpay.com.tw/2894/)
- ECPay warns that excessive query speed receives HTTP 403 and instructs merchants to
  reduce call speed and wait 30 minutes before retrying. Reconciliation must therefore
  rate-limit rather than loop aggressively. [Credit-card detail query](https://developers.ecpay.com.tw/2894/)

### Replay, outcomes, and safe interpretation

- The public pages require original identifiers and instruct a query before acting,
  but do **not** publish an idempotency key, duplicate-action response, replay window,
  or an at-most-once guarantee for `DoAction`. A timeout or lost response is therefore
  an **unknown provider outcome**, not evidence of failure and not authorisation to
  blindly resend the refund. Query the persisted provider identifiers before deciding
  on another action. This last sentence is an implementation inference from the
  documented query-before-action flow, not a provider guarantee.
  [Refund operation](https://developers.ecpay.com.tw/2885/), [Credit-card detail query](https://developers.ecpay.com.tw/2894/)
- A received refund response with `RtnCode=1` is provider-confirmed success; a
  non-`1` response is a provider rejection/failure and should retain `RtnMsg` as
  sanitised operational evidence. Network timeouts and HTTP-level failures are not
  assigned a final business result by the public pages. [Refund operation](https://developers.ecpay.com.tw/2885/)

## Facts that require merchant confirmation or UAT

Public documentation cannot establish any of the following for StoreWeave's merchant:

- that the merchant's production account has the credit-card refund and query products
  enabled, has sufficient account balance, or has the required production credentials;
- original payment data availability (`TradeNo`, `CreditRefundId`, `CreditCheckCode`,
  and `NeedExtraPaidInfo=Y`) for this merchant's chosen checkout flow;
- the merchant-approved rules for when to refund, whether partial refunds are offered,
  how multiple partial refunds are constrained, or how rejection is handled;
- exact production error-code mapping, duplicate/replay behaviour, retry timing,
  provider-side settlement timing, rate limits beyond the documented 403 warning, or
  callback behaviour;
- successful full-refund, partial-refund, rejection, timeout, duplicate, and query
  reconciliation UAT. The public pages explicitly rule out exercising these two APIs
  against a real-authorisation Stage environment.

## Separate POS API contract — do not substitute it for the legacy contract

ECPay also publishes a distinct **POS 全方位金流 API** refund contract. Its `/1.0.0`
paths, JSON/AES envelope, and asynchronous status semantics are materially different
from the legacy API above. The merchant must identify which product its account and
checkout use before implementing either; a POS capability does not prove permission to
call legacy `CreditDetail/DoAction`, or vice versa.

- POS refund is `POST` JSON to Stage
  `https://ecpayment-stage.ecpay.com.tw/1.0.0/Cashier/Refund` or production
  `https://ecpayment.ecpay.com.tw/1.0.0/Cashier/Refund`. Its outer request has
  `MerchantID`, `RqHeader.Timestamp` (GMT+8 Unix timestamp; documentation gives a
  10-minute validity window), and encrypted `Data`. Plaintext data requires the
  original `MerchantTradeNo`, `MerchantRefundNo`, and `RefundAmount`; `NotifyURL` is
  optional. [POS refund](https://developers.ecpay.com.tw/64711/)
- POS `Data` encrypts URL-encoded values using ECPay-supplied AES-128-CBC with PKCS7
  key and IV. `TransCode=1` only acknowledges reception of the envelope; decrypt the
  response and require `RtnCode=1` for successful API execution. [POS encryption appendix](https://developers.ecpay.com.tw/45948/), [POS refund](https://developers.ecpay.com.tw/64711/)
- POS response/business state is additionally `RefundStatus`: `0` processing, `1`
  success, or `2` failure, with `GatewayRefundTradeNo`. Thus `RtnCode=1` is not by
  itself a settled refund. [POS refund](https://developers.ecpay.com.tw/64711/)
- POS reconciliation is `POST` JSON to Stage
  `https://ecpayment-stage.ecpay.com.tw/1.0.0/POS/QueryTrade` or production
  `https://ecpayment.ecpay.com.tw/1.0.0/POS/QueryTrade`; it returns total
  `RefundAmount` and a `RefundList` keyed by `MerchantRefundNo`, including the same
  `RefundStatus`. [POS query](https://developers.ecpay.com.tw/64719/)
- When POS `NotifyURL` is used, ECPay asks the merchant to reply exact plain text
  `1|OK`; it is receipt acknowledgement only, not a state transition. Incorrect/no
  acknowledgement is retried after 5–15 minutes, up to four times that day. Its
  duplicate delivery must be safe. [POS refund notification](https://developers.ecpay.com.tw/64715/)
- POS public pages name `MerchantRefundNo`, but do not explicitly promise its
  uniqueness, idempotency, retry/replay semantics, or a client-timeout policy. Treat
  this as the same merchant/UAT gap rather than assuming that identifier is an
  idempotency key. [POS refund](https://developers.ecpay.com.tw/64711/)

Before Ticket 64 is unblocked, confirm the enabled product and credentials with the
merchant, preserve the listed identifiers at payment time, and run controlled
production-approved UAT without storing credentials or PII in the repository.

## Source verification

All cited sources are official ECPay developer-portal pages, opened on 2026-09-22.
This note deliberately distinguishes their published contract from merchant-specific
configuration and observed UAT results.
