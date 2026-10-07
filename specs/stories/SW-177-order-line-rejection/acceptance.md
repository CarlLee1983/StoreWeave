# SW-177 Acceptance

## Criteria

- [x] AC-001 / ORD-05: Different line failures are returned in one structured rejection; a healthy line is omitted.
- [x] AC-002 / ORD-05: A rejected request leaves no Order or inventory reservation.
- [x] AC-003 / ORD-04: Insufficient stock says only that stock is insufficient in the public API response and error message.
- [x] AC-004 / ORD-05: The storefront checkout page renders each rejected line and reason safely.
- [ ] AC-005: Focused checks and `make verify` pass.

## Evidence

- `pnpm typecheck` passed.
- `pnpm exec vitest run --project unit packages/commerce/cart/test/pages.test.ts packages/themes/default/test/default-theme.test.ts`: 55 passed.
- `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock pnpm exec vitest run --project integration tests/integration/flow-order-outbox.test.ts -t 'ORD-04|ORD-05|庫存不足時整筆訂單回滾'`: 3 passed, 9 skipped.
- `make verify` is reserved for the combined integration checkpoint.
