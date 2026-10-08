# SW-177 — Order line rejection (GitHub #117)

## Goal

When checkout cannot create an Order, report every affected line and its reason together so the customer can correct the request.

## Source and boundary

Source: [GitHub issue #117](https://github.com/CarlLee1983/StoreWeave/issues/117), approved for implementation by the user. This is the ORD-04 stock privacy slice and ORD-05 aggregate rejection slice. Order owns the decision and safe rejection data; Cart's storefront page and the selected Theme present it. The adapter and Theme changes are required to make the rejection usable end to end.

- In scope: Aggregate rejected line details from Order checkout and direct placement, omit healthy lines, keep all reservations and Order creation atomic, hide exact available stock in both API and error message, and render per-line reasons on the checkout page.
- Out of scope: Price reconfirmation (ORD-03), changing Cart's handling of inactive lines (GitHub #121), inventory model changes, payment changes, and platform error envelope changes.

## Constraints

Use the existing safe `VALIDATION_ERROR` details channel. A rejection lists product identity, stable reason, and customer-readable message without stock counts. Preserve unknown failures as failures rather than classifying them as stock shortages.

## Verification

Run focused Order integration, Cart page, and Theme tests; typecheck. The repository completion gate is `make verify` at integration checkpoint. See [acceptance.md](acceptance.md).
