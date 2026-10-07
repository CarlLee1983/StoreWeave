# SW-181 Acceptance

## Criteria

- [x] AC-001 / ORD-04: An archived line makes checkout fail with that line's identity and reason; healthy lines remain unreserved.
- [x] AC-002: The old silent exclusion assertion is replaced with rejection coverage.
- [x] AC-003: Storefront shows the unavailable line and offers a removal action.
- [ ] AC-004: Focused checks and `make verify` pass.

## Evidence

- `tests/integration/cart-checkout.test.ts`: 12 passed, including ORD-04 archived line and all-archived cases.
- `tests/integration/storefront-cart.test.ts`: 16 passed, including ORD-04 rejection and removal rendering.
- `tests/integration/cart-http.test.ts`: 17 passed, including current-Cart adapter cases.
- `pnpm typecheck` passed. The combined `make verify` gate remains pending.
