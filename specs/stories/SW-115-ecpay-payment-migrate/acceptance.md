# Acceptance Criteria

## Happy Path

* [x] AC-001: ECPay initiation maps the neutral Provider ABI without Order/Reservation input.
* [x] AC-002: Verified ECPay callbacks resolve the unique reference and preserve existing observable results.

## Failure Cases

* [x] AC-003: Invalid signature, unknown reference, and provider rejection are rejected distinctly.

## Regression Requirements

* [x] AC-004: Existing ECPay Commerce payment/callback tests pass.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `runPaymentProviderContractChecks` in `packages/extensions/ecpay/test/provider.test.ts` | neutral input, exact replay and four changed facts are covered without Order/Reservation fields |
| `AC-002` | test | V2 callback correlation, legacy adoption, and V2-to-legacy compatibility tests | signed events retain the original reference and trade mapping |
| `AC-003` | test | invalid signature, unknown trade, amount mismatch, unsupported initiation, and signed provider rejection cases | failures remain explicit and non-successful |
| `AC-004` | test | `packages/extensions/ecpay/test/provider.test.ts` and `tests/unit/ecpay-callback-http.test.ts` | legacy checkout, signed forms, callback HTTP handling, acknowledgement, and unsupported refund remain observable |

## Verification

- `pnpm exec vitest run --project unit packages/extensions/ecpay/test/provider.test.ts tests/unit/ecpay-callback-http.test.ts` — 2 files, 25 tests passed.
- `pnpm typecheck` — passed.
- `git diff --check` — passed.
- Independent Sol/high review — PASS, including the V2-to-legacy replay test.
- Concurrency tests use `InMemoryExtensionStore`; PostgreSQL `DbExtensionStore` locking is not exercised by this story's focused tests.
- Full `make verify` remains the repository completion gate and will be run after the remaining authorized stories.
