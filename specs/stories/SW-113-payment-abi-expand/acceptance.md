# Acceptance Criteria

## Happy Path

* [x] AC-001: New provider initiation accepts only reference, displayReference, amount, currency, and method.
* [x] AC-002: New refund contract has executable success, unsupported, and failed-result cases.

## Failure Cases

* [x] AC-003: Contract tests reject Order/Reservation-shaped inputs and invalid monetary/reference inputs.

## Regression Requirements

* [x] AC-004: Existing adapters and Commerce consumer remain buildable during the expand stage.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | extension SDK provider contract tests | domain-neutral request accepted |
| `AC-002` | test | refund contract fixtures | result category is explicit |
| `AC-003` | test | invalid ABI fixtures | validation rejects input |
| `AC-004` | command | focused adapter/Commerce typecheck | legacy consumers still build |

## Verification

- `pnpm exec vitest run --project unit packages/platform/extension-sdk/test/payment-contract.test.ts packages/extensions/mock-payment/test/provider.test.ts packages/extensions/ecpay/test/provider.test.ts` — 3 files, 39 tests passed.
- `pnpm typecheck` — passed; legacy adapters and Commerce consumers remain buildable.
- `pnpm exec vitest run --project unit tests/architecture/release-baseline.test.ts tests/architecture/b17-public-contract-semantic.test.ts` — 2 files, 13 tests passed.
- `make verify` — passed: unit 116 files / 1324 tests; admin 32 files / 351 tests; integration 107 files / 906 tests.
- Independent Sol/high review — PASS after the final replay-order regression test delta.
