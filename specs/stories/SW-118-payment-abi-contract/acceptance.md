# Acceptance Criteria

## Happy Path

* [ ] AC-001: Extension SDK exports only the domain-neutral Provider and refund ABI.
* [ ] AC-002: Mock, ECPay, and Commerce payment contract/regression suites pass against that single ABI.

## Failure Cases

* [ ] AC-003: Synthetic old ABI imports and Order-shaped provider payloads fail type/contract checks.

## Regression Requirements

* [ ] AC-004: No fallback, alias, compatibility branch, or remaining legacy consumer exists.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | extension SDK public-surface test | only neutral exports remain |
| `AC-002` | command | focused adapter and Commerce suites | all migrated consumers pass |
| `AC-003` | test | synthetic legacy fixtures | check rejects legacy use |
| `AC-004` | command | source/import inventory | no old path remains |

## Current Dependency Gate

* The SDK, Mock Payment, ECPay, and Commerce focused contract suites currently pass: 4 files / 58 tests on 2026-09-22. These checks validate the additive transition surface; they do not prove ABI contraction.
* `packages/platform/extension-sdk/src/providers.ts` still exports `PaymentStartInput`, `PaymentProvider`, and `PaymentProviderDuringMigration` alongside `PaymentProviderV2`, and the SDK contract test deliberately verifies that a transitional provider remains registrable. This is the expected pre-contract state.
* SW-118 depends on SW-116 and SW-117. SW-117 and the consumer-migration prerequisite are complete, but SW-116 AC-001/AC-003 remain blocked by the missing merchant-approved ECPay refund product/API contract and staging UAT evidence. Keep AC-001–004 unchecked until that dependency is cleared and the legacy SDK surface can be removed within this story's boundary.
