# SW-184 verification evidence

## Successful tested checkpoint

- Code commit: `a8bd14162154e0cf89bcf5f40d649bae05dc1d98`; PR target `464dcd8202e1fcc5d157cc412d969d1398ea5435` (`origin/main`).
- Execution date: 2026-10-08 Asia/Taipei; complete gate finished at approximately 10:07.
- Worktree: `/tmp/storeweave-order-pr-2cDJVpz2`, independently installed with the frozen lockfile; clean before and after the gate. The unrelated local Dining commit is absent from this branch.
- Node 24.21.0; pnpm 12.0.0; OrbStack Docker 29.4.0; PostgreSQL `17-alpine` testcontainers.
- Command: `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock make verify`.
- Final process exit: **0**. Subsequent changes are documentation-only and identify this exact tested code commit.

| Gate | Result |
| --- | --- |
| Backend typecheck | Passed |
| Admin typecheck | Passed |
| Unit | 161 files, 1,603 tests passed |
| Admin | 32 files, 351 tests passed |
| Integration | 123 files, 1,068 tests passed |

## Scenario locations

Every numbered scenario below passed in the complete gate at the fixed code commit. Evidence covers cart checkout, its REST cart and SSR Storefront entry points. Shared rejection tests also exercise the legacy direct order boundary; this does not certify `POST /api/v1/orders` against the complete checkout contract. Its separate follow-up is [issue #125](https://github.com/CarlLee1983/StoreWeave/issues/125).

| 情境 | StoreWeave 測試 |
| --- | --- |
| ORD-01 | [`order-replay-conformance.test.ts:45`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-replay-conformance.test.ts#L45) |
| ORD-02 | [`order-existing-conformance.test.ts:44`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L44) |
| ORD-03 | [`storefront-cart.test.ts:221`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/storefront-cart.test.ts#L221)、[`order-price-confirmation.test.ts:43`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-price-confirmation.test.ts#L43) |
| ORD-04 | [`flow-order-outbox.test.ts:64`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/flow-order-outbox.test.ts#L64)、[`storefront-cart.test.ts:434`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/storefront-cart.test.ts#L434)、[`storefront-cart.test.ts:449`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/storefront-cart.test.ts#L449)、[`cart-checkout.test.ts:248`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/cart-checkout.test.ts#L248)、[`cart-checkout.test.ts:274`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/cart-checkout.test.ts#L274)、[`cart-hardening.test.ts:141`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/cart-hardening.test.ts#L141) |
| ORD-05 | [`flow-order-outbox.test.ts:84`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/flow-order-outbox.test.ts#L84) |
| ORD-06 | [`order-existing-conformance.test.ts:58`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L58) |
| ORD-07 | [`order-existing-conformance.test.ts:72`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L72) |
| ORD-08 | [`order-existing-conformance.test.ts:86`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L86) |
| ORD-09 | [`order-checkout-retry.test.ts:40`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-checkout-retry.test.ts#L40)、[`order-existing-conformance.test.ts:100`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L100) |
| ORD-10 | [`order-existing-conformance.test.ts:124`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-existing-conformance.test.ts#L124) |
| ORD-11 | [`order-replay-conformance.test.ts:61`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-replay-conformance.test.ts#L61) |
| ORD-12 | [`order-customer-idempotency.test.ts:33`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-customer-idempotency.test.ts#L33) |
| ORD-13 | [`order-replay-conformance.test.ts:74`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-replay-conformance.test.ts#L74) |
| ORD-14 | [`order-replay-conformance.test.ts:97`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-replay-conformance.test.ts#L97) |
| ORD-15 | [`order-price-confirmation.test.ts:95`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-price-confirmation.test.ts#L95) |
| ORD-16 | [`order-shipping-fee-confirmation.test.ts:43`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-shipping-fee-confirmation.test.ts#L43)、[`storefront-cart.test.ts:162`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/storefront-cart.test.ts#L162) |
| ORD-17 | [`order-shipping-fee-confirmation.test.ts:100`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-shipping-fee-confirmation.test.ts#L100) |
| ORD-18 | [`order-checkout-retry.test.ts:82`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-checkout-retry.test.ts#L82) |
| ORD-19 | [`order-replay-conformance.test.ts:138`](https://github.com/CarlLee1983/StoreWeave/blob/a8bd14162154e0cf89bcf5f40d649bae05dc1d98/tests/integration/order-replay-conformance.test.ts#L138) |

## Regression and baseline verification

Before the successful gate, the focused PostgreSQL run of `checkout-pricing.test.ts`, `pickup-store-selection.test.ts`, and `order-checkout-retry.test.ts` passed all 16 tests. The complete gate also passed those files, including the reversed-line concurrent checkout and same-key retry paths.

The semantic generator and complete release baseline projector both ran successfully after access was restored. Their generated candidates exactly matched the reviewed checked-in artifacts. The source correction preserves input order for pricing allocation while retaining sorted lock acquisition. The pickup fixture confirms its actual displayed price and shipping fee; existing pricing assertions remain intact. No dependency or schema migration was added.

## Prior failed checkpoint

At `269f546264b137b968357630e40cfe74e23318df`, the gate failed with 1,064 Integration tests passed and 4 failed in checkout pricing and pickup selection. Those failures exposed the pricing input-order regression and missing fixture confirmations. They were fixed in the tested commit above. An earlier release-digest failure was corrected against the approved checkout contract without weakening the exact baseline assertions. Prior architect and reviewer findings were resolved; their accepted boundary analysis remains applicable.

The successful run emitted existing Vite import and PostgreSQL client deprecation warnings. They did not fail any gate. Raw local execution log: `/tmp/storeweave-order-verify-resume-20261008.log`; sanitized suite results and fixed test links are the published evidence.

## External delivery

WebForge implementation tables are updated locally after this passing gate. Its seven preexisting unpublished commits will not be pushed. The fixed-commit report was published as [WebForge issue #1](https://github.com/CarlLee1983/WebForge/issues/1) and verified with `gh issue view` on 2026-10-08. It contains all ORD-01–ORD-19 locations, executed results, environment, command, tested commit and explicit scope. Table updates remain local; the report is published.

## CI smoke contract follow-up (2026-10-08)

[PR #126's first Actions run](https://github.com/CarlLee1983/StoreWeave/actions/runs/37716559398) passed typecheck/unit/admin, both PostgreSQL integration shards and both Base smoke jobs. Both Commerce smoke jobs failed only because the shared smoke script still expected HTTP 409 for insufficient stock; SW-177's structured `VALIDATION_ERROR` contract maps to HTTP 400.

At `baa1a7de803656c188ea7281a452f284de071071`, only `scripts/smoke.sh` changed: it expects 400 and checks the structured rejection, the exact safe message and line fields, and unchanged stock (on hand 10, reserved 2). No production implementation, dependency or migration changed. Shell syntax and `git diff --check` passed; independent reviewer accepted this delta.

| Focused release gate | Executed result |
| --- | --- |
| Commerce Docker smoke | Exit 0; 74 checks passed, 0 failed; full backup/restore passed |
| Commerce native tarball smoke | Exit 0; 73 checks passed, 0 failed; full backup/restore passed |

Docker rebuilt the release and ran on isolated Compose port 3326; native executed the checksum-bound x64 tarball in an isolated Debian container on port 3327. Both generated passing manifest-bound smoke evidence identifying the exact commit above. Local evidence: `/tmp/storeweave-126-docker-smoke/evidence.json` and `/tmp/storeweave-126-native-evidence.json`.

The passing full `make verify` checkpoint above remains the evidence for unchanged application sources; this follow-up exercises the changed smoke boundary directly. A fresh PR CI run verifies the complete head after publication.
