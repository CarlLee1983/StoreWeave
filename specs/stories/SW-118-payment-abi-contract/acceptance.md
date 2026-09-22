# Acceptance Criteria

## Happy Path

* [x] AC-001: Extension SDK exports only the domain-neutral Provider and refund ABI.
* [x] AC-002: Mock, ECPay, and Commerce payment contract/regression suites pass against that single ABI.

## Failure Cases

* [x] AC-003: Synthetic old ABI imports and Order-shaped provider payloads fail type/contract checks.

## Regression Requirements

* [x] AC-004: No fallback, alias, compatibility branch, or remaining legacy consumer exists.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | SDK contract test plus full `make verify` | only neutral exports remain |
| `AC-002` | command | focused adapter/Commerce suites plus full `make verify` | all migrated consumers pass |
| `AC-003` | test | typecheck-consumed synthetic legacy imports and runtime contract fixtures | old imports and Order-shaped payloads are rejected |
| `AC-004` | command | source/import inventory plus full `make verify` | no old path remains |

## Current Dependency Gate

* SW-118 removes the Order-specific `PaymentStartInput`, `PaymentStartResult`, `PaymentRefundInput`, `PaymentProvider`, and `PaymentProviderDuringMigration` exports, plus its legacy `PaymentFailedResult`. The SDK contract test uses typecheck-consumed negative imports for every removed export and retains the runtime test that rejects a legacy-only provider.
* On 2026-09-22, focused SDK, Mock Payment, ECPay, Commerce callback/payment, and Commerce refund checks passed: 10 files / 120 tests; `pnpm typecheck` also passed. The final `make verify` passed: unit 138 files / 1430 tests, admin 32 files / 351 tests, and integration 111 files / 942 tests.
* SW-118 depends on SW-116 and SW-117. SW-117 and the consumer-migration prerequisite are complete. On 2026-09-22, Carl Lee accepted proceeding with this SDK-only ABI cleanup while the separate ECPay merchant product contract and staging UAT remain unverified. This exception does not assert refund readiness or clear that external release gate; it does not affect the completed SDK-only AC-001–004.
