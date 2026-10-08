# SW-183 Acceptance

## Criteria

- [x] AC-001 / ORD-16: A changed fee rejects checkout with the current fee and leaves no Order or reservation.
- [x] AC-002 / ORD-17: A successful Order returns on same-key replay after a fee change without creating another Order.
- [x] AC-003: REST and storefront requests require the customer-confirmed fee; the storefront shows the new fee for reconfirmation.
- [x] AC-004: Only confirmed fee is omitted from checkout replay matching; line prices and destination remain matched.
- [x] AC-005: Focused checks and `make verify` pass.

## Evidence

- `tests/integration/order-shipping-fee-confirmation.test.ts`: ORD-16/ORD-17 passed; final Order count and reservation asserted.
- `tests/integration/storefront-cart.test.ts`: ORD-16 fee display, hidden current fee, and retry passed.
- `tests/integration/cart-http.test.ts`: 17 passed with required REST quote payloads.
- `pnpm typecheck` passed. The combined `make verify` gate passed at `a8bd141` on 2026-10-08; see [complete verification evidence](../SW-184-order-conformance-verification/verification.md).
