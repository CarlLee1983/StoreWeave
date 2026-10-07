# SW-182 — Confirm each Cart line price at checkout (GitHub #122)

## Goal

Checkout compares the unit price the customer confirmed for every Cart line with the current Catalog price. A change in either direction rejects the Order and shows the new unit price for explicit reconfirmation.

## Source and boundary

Source: [GitHub issue #122](https://github.com/CarlLee1983/StoreWeave/issues/122), approved by the user. Depends on SW-177 line rejection. The request carries a required, normalized line price snapshot. Order compares it inside the same transaction as reservation. Cart storefront sends the displayed prices; REST callers provide the same field.

- In scope: Exact Cart line coverage, price change rejection with current unit price, same-key retry after rejection, and storefront reconfirmation.
- Out of scope: Shipping fee confirmation (SW-183), payment, inventory model changes, and implicit server acceptance of absent prices.

## Verification

Run focused price integration, Cart page, Theme, and type checks, then the combined `make verify` gate. See [acceptance.md](acceptance.md).
