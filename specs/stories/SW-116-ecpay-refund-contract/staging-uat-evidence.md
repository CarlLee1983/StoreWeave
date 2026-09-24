# ECPay Refund Staging UAT Gate

**Status: BLOCKED.** This template is not evidence that an ECPay refund product is enabled or that UAT passed. Do not select ECPay for a refundable release until the merchant-specific contract is approved and the required staging evidence below is recorded.

## Release-owner approval

Carl Lee approved the SW-116 local implementation on 2026-09-22. This approval
does not clear the UAT gate: the merchant-approved contract and all required
sanitized staging evidence remain outstanding.

## Risk acceptance for local-work closure

On 2026-09-22, Carl Lee accepted the risk of treating SW-116's local
implementation work as complete based on the documented public API baseline and
the recorded local verification. This is not merchant UAT approval and does not
assert that an ECPay merchant account is entitled to refunds.

This acceptance does not clear this gate, enable the default-disabled adapter,
authorize a production refund, or permit ECPay to be selected for a refundable
release. Those actions still require the merchant-approved contract and the
sanitized evidence below.

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

## Public-contract baseline (not merchant approval)

On 2026-09-22 the release owner supplied ECPay's official
[legacy AIO credit-card refund operation](https://developers.ecpay.com.tw/2885/).
It documents production-only form posts to
`https://payment.ecpay.com.tw/CreditDetail/DoAction`, signed with
`CheckMacValue`, and a state-dependent `N` / `E` then `N` / `R` workflow. Its
linked [credit-card detail query](https://developers.ecpay.com.tw/2894/) requires
`CreditRefundId` (`gwsr` from a signed payment callback with
`NeedExtraPaidInfo=Y`), `CreditAmount`, and merchant `CreditCheckCode` before an
action can be selected. The complete source-grounded analysis is in
[the ECPay credit refund and reconciliation contract note](../../../docs/research/64-ecpay-credit-refund-and-reconciliation-contract.md).

This establishes a candidate legacy AIO implementation contract only. It does
not fill any blank field above: the merchant account identifier, account
entitlement, `CreditCheckCode` secret, replay/recovery agreement, and every UAT
case remain required before this gate can clear.

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
