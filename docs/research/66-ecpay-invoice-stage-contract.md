# Ticket 66 — ECPay electronic-invoice Stage contract research

**Date:** 2026-08-25  
**Scope:** ECPay's official public documentation only. The merchant selected ECPay and
authorized use of ECPay-provided test materials. This note deliberately contains no
credentials and does not make tax or operational decisions for the merchant.

## Confirmed provider facts

- ECPay documents separate B2C and B2B electronic-invoice API families, including
  issuing, voiding, allowance, notification, and query operations. The choice of API
  flow still depends on the merchant's customer and accounting requirements.
  [ECPay developer portal](https://developers.ecpay.com.tw/)
- ECPay publishes a public Stage test environment for electronic invoices. Its test
  integration page states that, after successful ECPay validation, Stage invoices are
  marked uploaded rather than actually submitted to the Ministry of Finance, so that
  void and allowance testing can continue. This is test evidence only, not production
  tax evidence. [ECPay test integration information](https://developers.ecpay.com.tw/24174/)
- ECPay's B2C API documentation uses HTTPS JSON requests with an encrypted `Data`
  payload, merchant identity, and a timestamp. Its documented invoice-query endpoint
  has separate Stage and production hostnames. [B2C invoice detail query](https://developers.ecpay.com.tw/7923/)
- ECPay documents a delayed/triggered issuance flow: data is first stored, then an
  explicit trigger after payment causes immediate or configured delayed issuance.
  This is an available provider capability, not a decision that StoreWeave should make
  automatically. [Trigger invoice issue](https://developers.ecpay.com.tw/15371/)

## Implementation boundary

The existing product specification requires an independent provider boundary and
requires the merchant to decide issuance timing, B2C/B2B fields, carrier and donation
needs before implementation. It also requires invoice issue, void, and allowance
records to remain auditable and never roll back confirmed payment or refund facts.
See [commerce operations specification](../specs/0006-commerce-operations-closure.md).

## Decisions still required from the merchant

1. **Production enablement:** the merchant's ECPay electronic-invoice product is
   contracted and its production keys are made available through the approved secret
   provider. Do not place them in source control or chat.

## Merchant-confirmed operational rules

On 2026-08-25 the merchant selected B2C only, issuance after payment success, and
checkout support for ECPay carrier, mobile barcode, natural-person certificate, and
donation choices. Prices are tax-inclusive at the 5% standard rate (`TaxType=1`,
`vat=1`); zero-rated, exempt, and mixed-tax cases are outside this first slice. A
successful full refund must void the invoice. Partial-refund treatment is intentionally
not inferred: no void or allowance action may be sent until the merchant approves a
separate policy.

The adapter validates donation codes with ECPay's `CheckLoveCode` API before issuing;
format validation alone is not treated as proof that a code is valid. ECPay documents
that check as backed by its regularly refreshed Ministry of Finance donation-code
data. [Love-code verification](https://developers.ecpay.com.tw/22027/)

## Stage UAT evidence

On 2026-08-25, using ECPay's public Stage fixture and deliberately non-real customer
data, StoreWeave's adapter successfully completed: (1) a valid love-code check,
(2) B2C tax-inclusive issue with ECPay carrier, and (3) immediate B2C void of that
same Stage invoice. No credentials, customer data, or invoice number are retained in
this repository. ECPay documents that Stage invoices accepted by its validation are
marked uploaded for continued test operations rather than sent to the Ministry system.
[ECPay Stage fixture information](https://developers.ecpay.com.tw/7849/)

## Consequence of no public callback domain

The absent public callback domain blocks payment and logistics callback UAT in Ticket
58. It does not, by itself, prevent direct outbound calls to ECPay's invoice Stage
API, but any inbound invoice notification or production callback requirement must be
verified once a stable public HTTPS endpoint exists.
