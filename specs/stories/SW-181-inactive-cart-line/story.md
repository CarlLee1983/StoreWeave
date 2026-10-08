# SW-181 — Reject unavailable cart lines (GitHub #121)

## Goal

When a product is archived after a customer adds it to a Cart, checkout identifies that line and refuses the entire Order. The customer can remove it explicitly.

## Source and boundary

Source: [GitHub issue #121](https://github.com/CarlLee1983/StoreWeave/issues/121), approved by the user. Depends on SW-177 aggregate rejection. Order owns the checkout decision; Cart exposes the unavailable line identity; Theme renders the reason and removal action.

The previous test deliberately accepted an Order after silently filtering archived items because the Cart view also hid them. This becomes unsafe once a customer expects every selected line to be included: a smaller Order can be placed without explicit consent. The checkout decision must consider all Cart lines. The Cart view may exclude an unavailable line from its priced quote, but must still identify it and offer removal.

- In scope: Reject unavailable lines, retain their identity for storefront removal, show per-line checkout reasons, and update the prior filtering assertions.
- Out of scope: Inventory model changes and unrelated Cart merge policy.

## Verification

Run focused Cart and Order integration tests, Theme tests, typecheck, and the combined `make verify` gate. See [acceptance.md](acceptance.md).
