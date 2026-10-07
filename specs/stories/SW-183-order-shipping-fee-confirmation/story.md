# SW-183 — Confirm shipping fee at checkout (GitHub #123)

## Goal

Checkout compares the shipping fee the customer confirmed with the merchant's current fee. A changed fee rejects the Order and reports the current amount. A successful Order remains replayable with the same key after the merchant changes its fee.

## Source and boundary

Source: [GitHub issue #123](https://github.com/CarlLee1983/StoreWeave/issues/123), approved by the user. Depends on SW-177 and SW-182. Shipping owns fee calculation; Order validates the checkout snapshot before creating an Order. The confirmed fee is excluded from the checkout replay fingerprint alone.

- In scope: Required confirmed fee in REST and storefront inputs, transaction-time comparison, current fee response, storefront reconfirmation, and successful same-key replay after fee changes.
- Out of scope: Other delivery changes, payment, and shipping method migration.

## Verification

Run focused fee integration, Cart page, Theme, and type checks, then the combined `make verify` gate. See [acceptance.md](acceptance.md).
