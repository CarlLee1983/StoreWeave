# ECPay Refund Staging UAT Gate

**Status: BLOCKED.** This template is not evidence that an ECPay refund product is enabled or that UAT passed. Do not select ECPay for a refundable release until the merchant-specific contract is approved and the required staging evidence below is recorded.

## Merchant-approved contract

| Field | Evidence |
| --- | --- |
| Merchant account identifier | Masked identifier and environment; never include credentials |
| Enabled ECPay refund/query product and API version | |
| Authoritative merchant/ECPay documentation and revision date | |
| Endpoint host and operation for staging | |
| Required request identifiers and mapping from payment/refund references | |
| Request signing/encryption and response authentication rules | |
| Supported payment methods and full/partial refund rules | |
| Duplicate, replay, and provider idempotency behavior | |
| Timeout/response-loss recovery, query, and reconciliation contract | |
| Provider-confirmed success and definitive rejection fields | |

The public [ECPay AIO Capture and Refund documentation](https://developers.ecpay.com.tw/16567/) describes one credit-card product whose refund path depends on transaction status and states that its staging API cannot be used without real authorizations. That public document is not proof that this merchant account has the product enabled, and it does not select the product for this adapter.

## Staging cases

Record one sanitized evidence reference per case. Use the merchant-approved product contract to determine expected results before running UAT.

| Case | Expected observation | Sanitized evidence reference | Operator | Timestamp with timezone | Result |
| --- | --- | --- | --- | --- | --- |
| Provider-confirmed supported refund | Only authenticated provider confirmation maps to `succeeded` | | | | |
| Definitive provider rejection | Non-success result with auditable reason | | | | |
| Unknown original transaction | Non-success; no fabricated provider refund reference | | | | |
| Duplicate/replayed refund reference | Same request does not create a second provider refund | | | | |
| Changed facts on an existing refund reference | Rejected before another provider request | | | | |
| Timeout or response loss | Remains unresolved until the confirmed query/reconciliation flow determines the outcome | | | | |
| Recovery after the provider acted but the response was lost | No second refund is issued during recovery | | | | |

## Gate clearance

Clear this gate only when the merchant-approved contract is complete, all applicable staging cases have evidence, unresolved outcomes have been reconciled without duplicate refunds, and the named release owner records approval. Local mocks and unit tests do not clear this gate.

Do not attach credentials, Hash Key/IV, CheckMacValue, full request or callback bodies, cardholder data, or other personal information. Store source records in the approved restricted release-evidence location and link only to sanitized evidence here.
