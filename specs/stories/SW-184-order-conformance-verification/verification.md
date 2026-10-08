# SW-184 verification checkpoint (failed gate)

## Tested checkpoint

- Commit: `269f546264b137b968357630e40cfe74e23318df`.
- PR target: `464dcd8202e1fcc5d157cc412d969d1398ea5435` (`origin/main`).
- Clean worktree: `/tmp/storeweave-order-pr-2cDJVpz2`; frozen lockfile install succeeded before the run; no tracked or untracked changes at start.
- Execution date: 2026-10-08 Asia/Taipei.
- Node 24.21.0; pnpm 12.0.0; Docker 29.4.0; PostgreSQL `17-alpine` testcontainers.
- Command: `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock make verify`.

## Observed results

| Gate | Result |
| --- | --- |
| Backend typecheck | Passed |
| Admin typecheck | Passed |
| Unit | 161 files, 1,603 tests passed |
| Admin | 32 files, 351 tests passed |
| Integration | 123 files: 121 passed, 2 failed; 1,064 tests passed, 4 failed; make exited with test-integration Error 1 |

The first full attempt stopped on an outdated release contract digest. The approved checkout contract baseline correction retained exact assertions and passed its 10 focused tests. The second attempt reached Integration. After the execution environment switched to restricted access, its tool process handle was unavailable and new Docker socket access was denied. The original Integration log continued producing results, so no duplicate run was started. GitHub CLI could not reach api.github.com; its authentication error does not establish that credentials are actually invalid. The original log subsequently finished: checkout-pricing had three failures caused by changed line ordering and discount tie allocation; pickup-store-selection had one fixture missing required confirmations. These are material failures. A follow-up restores pricing input order while preserving sorted locks, and migrates the pickup fixture. Both require fresh focused Integration and complete-gate results. No complete-gate success, publication, or cross-stack maturity claim is made.

## Scenario locations

The numbered scenario files passed in this run, but the complete Integration gate failed as recorded above. These links identify the tested checkpoint; follow-up fixes require a new tested commit.

| 情境 | StoreWeave 測試 |
| --- | --- |
| ORD-01 | [`order-replay-conformance.test.ts:45`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-replay-conformance.test.ts#L45) |
| ORD-02 | [`order-existing-conformance.test.ts:44`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L44) |
| ORD-03 | [`storefront-cart.test.ts:221`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/storefront-cart.test.ts#L221)、[`order-price-confirmation.test.ts:43`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-price-confirmation.test.ts#L43) |
| ORD-04 | [`flow-order-outbox.test.ts:64`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/flow-order-outbox.test.ts#L64)、[`storefront-cart.test.ts:434`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/storefront-cart.test.ts#L434)、[`storefront-cart.test.ts:449`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/storefront-cart.test.ts#L449)、[`cart-checkout.test.ts:248`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/cart-checkout.test.ts#L248)、[`cart-checkout.test.ts:274`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/cart-checkout.test.ts#L274)、[`cart-hardening.test.ts:141`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/cart-hardening.test.ts#L141) |
| ORD-05 | [`flow-order-outbox.test.ts:84`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/flow-order-outbox.test.ts#L84) |
| ORD-06 | [`order-existing-conformance.test.ts:58`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L58) |
| ORD-07 | [`order-existing-conformance.test.ts:72`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L72) |
| ORD-08 | [`order-existing-conformance.test.ts:86`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L86) |
| ORD-09 | [`order-checkout-retry.test.ts:40`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-checkout-retry.test.ts#L40)、[`order-existing-conformance.test.ts:100`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L100) |
| ORD-10 | [`order-existing-conformance.test.ts:124`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-existing-conformance.test.ts#L124) |
| ORD-11 | [`order-replay-conformance.test.ts:61`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-replay-conformance.test.ts#L61) |
| ORD-12 | [`order-customer-idempotency.test.ts:33`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-customer-idempotency.test.ts#L33) |
| ORD-13 | [`order-replay-conformance.test.ts:74`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-replay-conformance.test.ts#L74) |
| ORD-14 | [`order-replay-conformance.test.ts:97`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-replay-conformance.test.ts#L97) |
| ORD-15 | [`order-price-confirmation.test.ts:95`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-price-confirmation.test.ts#L95) |
| ORD-16 | [`order-shipping-fee-confirmation.test.ts:43`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-shipping-fee-confirmation.test.ts#L43)、[`storefront-cart.test.ts:162`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/storefront-cart.test.ts#L162) |
| ORD-17 | [`order-shipping-fee-confirmation.test.ts:100`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-shipping-fee-confirmation.test.ts#L100) |
| ORD-18 | [`order-checkout-retry.test.ts:82`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-checkout-retry.test.ts#L82) |
| ORD-19 | [`order-replay-conformance.test.ts:138`](https://github.com/CarlLee1983/StoreWeave/blob/269f546264b137b968357630e40cfe74e23318df/tests/integration/order-replay-conformance.test.ts#L138) |

## Remaining acceptance

Finish a complete clean-environment `make verify`, record its final exit and Integration totals, update WebForge’s implementation table, deliver the external evidence report, and publish the authorized PR. The existing acceptance checkboxes for these steps remain unchecked.

## Follow-up working diff (not yet a verified commit)

- Preserve original input indices for pricing/materialization while acquiring product/inventory locks in sorted product order. Existing pricing regression assertions remain intact.
- Pickup fixture confirms its displayed 1,000-cent product and selected 60-cent fee; replay uses the identical payload.
- Backend typecheck and focused allocation/retry unit tests (15/15) pass.
- Semantic candidate changed only source provenance fingerprints. The release fixture’s semantic input hash was refreshed to the reviewed file bytes. Full projector execution remains pending because its internal tsx IPC socket is denied in the restricted environment.
- Architect and reviewer found the pricing fix sound. These reviews and focused units do not prove PostgreSQL or complete-gate success.
- Pending external access: Docker socket, GitHub API network, Git metadata writes, and WebForge repository writes. Do not publish or mark conformance accepted before the remaining gate and evidence delivery succeed.

## Restricted-environment follow-up checks (2026-10-08)

Executed in the PR worktree after the pricing/pickup corrections:

- `pnpm typecheck` and `pnpm typecheck:admin`: passed.
- `pnpm exec vitest run --project unit packages/commerce/cart/test/pages.test.ts packages/themes/default/test/default-theme.test.ts packages/commerce/order/test/checkout-retry.test.ts packages/commerce/promotion/test/adjustment-allocation.test.ts packages/releases/commerce/test/commerce-release.test.ts`: 5 files, 83 tests passed.
- `git diff --check`: passed.
- Revalidated blockers: Docker socket returns permission denied; `gh repo view CarlLee1983/StoreWeave --json nameWithOwner` cannot connect to api.github.com.

These checks do not execute either failing PostgreSQL integration suite or the complete gate. Acceptance remains pending.
