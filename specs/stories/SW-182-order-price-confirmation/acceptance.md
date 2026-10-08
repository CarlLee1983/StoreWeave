# SW-182 Acceptance

## Criteria

- [x] AC-001 / ORD-03: Any higher or lower current unit price rejects checkout with each affected line's current unit price.
- [x] AC-002 / ORD-15: Rejected checkout does not consume its idempotency key; explicit confirmation at current prices succeeds with the same key.
- [x] AC-003: Storefront displays current prices and submits a fresh confirmation, retaining entered delivery information.
- [x] AC-004: REST and storefront inputs require confirmed prices for all actual Cart lines.
- [x] AC-005: Focused checks and `make verify` pass.

## Evidence

- `tests/integration/order-price-confirmation.test.ts`: ORD-03/ORD-15 passed.
- `tests/integration/storefront-cart.test.ts`: ORD-03/ORD-15 page and retry passed.
- `packages/commerce/cart/test/pages.test.ts` and `packages/themes/default/test/default-theme.test.ts`: focused unit tests passed after request migration.
- `pnpm typecheck` passed. The combined `make verify` gate passed at `a8bd141` on 2026-10-08; see [complete verification evidence](../SW-184-order-conformance-verification/verification.md).
