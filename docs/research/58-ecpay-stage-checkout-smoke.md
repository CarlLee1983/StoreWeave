# ECPay Stage Checkout Smoke

**Executed:** 2026-08-25. **Scope:** StoreWeave `ecpay` payment provider's signed
checkout form, plus one public-fixture Stage credit-card completion through a
temporary HTTPS callback. This is not merchant UAT and not production evidence.

## Result

Using ECPay's officially published non-3DS Stage fixture and the provider's actual
`form_post` output, the following requests all returned HTTP 200 with the page title
`選擇支付方式|綠界科技`:

| StoreWeave method | Submitted `ChoosePayment` | Stage request accepted | Merchant trade number length |
| --- | --- | --- | --- |
| `card` | `Credit` | yes | 20 |
| `atm` | `ATM` | yes | 20 |
| `cvs_code` | `CVS` | yes | 20 |
| `cvs_barcode` | `BARCODE` | yes | 20 |

Each request was for TWD 1, used a fresh provider-generated reference, and included
the provider-generated SHA-256 `CheckMacValue`. No card data was entered and no
payment was completed. The temporary test uses ECPay's public Stage fixture only;
no merchant secret was read, stored, or logged.

## Stage credit-card callback completion

A separate synthetic StoreWeave order was created with the public non-3DS Stage
fixture, then completed through ECPay's Stage payment simulator. The temporary API
was reachable at a fresh HTTPS tunnel URL; neither its URL nor callback payload was
retained in this repository.

- ECPay Stage issued `POST /callbacks/payment/ecpay` to that temporary public URL.
- The tunnel recorded HTTP 200 and its captured response contained the exact
  acknowledgement `1|OK`.
- StoreWeave verified the callback and moved the synthetic order/payment attempt from
  `payment_processing` / `submitted` to `paid` / `succeeded`.

The temporary database, API, tunnel, and public-fixture material are test-only and
are removed after verification.

## Official contract checked

- The Stage checkout endpoint is `https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5`.
- ECPay documents the submitted method values, integer-TWD amount, unique
  alphanumeric merchant trade number, and server `ReturnURL` requirements in its
  [All-in-One checkout API](https://developers.ecpay.com.tw/16449/).
- ECPay documents public Stage fixtures and test-card details separately in its
  [Stage testing guide](https://developers.ecpay.com.tw/35542/).
- The payment-result callback must be a publicly reachable server POST and receive
  exact `1|OK` after durable acceptance; see the [payment-result callback
  contract](https://developers.ecpay.com.tw/16538/). Deferred methods additionally
  need a reachable `PaymentInfoURL`; see the [payment-info callback
  contract](https://developers.ecpay.com.tw/16557/).

## Remaining release gate

This evidence proves that ECPay Stage accepts the provider's checkout form and that
one public-fixture credit-card success callback reaches StoreWeave correctly. It does
**not** prove failure/expiry, deferred-payment `PaymentInfoURL`, ECPay-originated
callback replay, signature handling against a merchant-owned account, or merchant
method availability. Those remain the unchecked Ticket 58 UAT and production
sign-off items. It also does not establish the merchant's refund/query capability
required by Ticket 64, nor choose the invoice provider required by Ticket 66.
