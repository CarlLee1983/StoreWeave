# Acceptance Criteria

## Happy Path

* [x] AC-001: Mock initiation and callback correlation use the SW-113 reference-based ABI.
* [x] AC-002: Mock adapter passes the shared refund contract success case.

## Failure Cases

* [x] AC-003: Unknown/duplicate references and invalid refunds follow contract-defined errors.

## Regression Requirements

* [x] AC-004: Existing mock-driven Commerce payment tests retain their observable behavior.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `packages/extensions/mock-payment/test/provider.test.ts` initiation and callback cases | neutral ABI accepted; unknown or mismatched callback references rejected |
| `AC-002` | test | shared `runPaymentProviderContractChecks` case in mock adapter tests | supported V2 refund succeeds |
| `AC-003` | test | mock adapter failure and compatibility cases | unavailable refunds reject; exact legacy successes replay; conflicting facts reject |
| `AC-004` | integration | `tests/integration/cart-checkout.test.ts`, `tests/integration/refund-domain.test.ts` | existing checkout and refund behavior retained |

## Verification

- `pnpm exec vitest run --project unit packages/extensions/mock-payment/test/provider.test.ts packages/platform/extension-sdk/test/payment-contract.test.ts` — 2 files, 32 tests passed.
- `pnpm exec vitest run --project integration tests/integration/cart-checkout.test.ts tests/integration/refund-domain.test.ts` — 2 files, 16 tests passed.
- `pnpm typecheck` — passed.
- `git diff --check` — passed.
- Independent Sol/high review — PASS, including legacy refund replay and second-page legacy charge lookup.
