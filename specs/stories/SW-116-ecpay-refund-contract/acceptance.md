# Acceptance Criteria

**Status: done (local implementation); merchant UAT release gate remains blocked.**

## Happy Path

* [x] AC-001: ECPay passes local shared refund-contract success and correlation cases.
* [x] AC-002: A release-gate evidence record explicitly requires ECPay staging refund UAT and names the evidence needed to clear it; this local Story does not assert UAT completion.

## Failure Cases

* [x] AC-003: Rejected, duplicate, unknown, timeout, and provider-failed refunds remain auditable non-success results.

## Regression Requirements

* [x] AC-004: ECPay payment initiation and callback behavior from SW-115 remains unchanged.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `packages/extensions/ecpay/test/provider.test.ts` success/replay fixtures and `paymentRefundResultSchema` | confirmed card callback persists `gwsr`; query precedes signed production action; provider-confirmed success replays without another request |
| `AC-002` | document review | [staging-uat-evidence.md](staging-uat-evidence.md) | required contract fields and staging cases are documented; UAT remains uncleared |
| `AC-003` | test | `packages/extensions/ecpay/test/provider.test.ts` rejection/unknown/timeout fixtures | unknown provider state and provider rejection remain rejected; transport uncertainty persists an indeterminate ledger and never blindly repeats `DoAction`; duplicate input replays |
| `AC-004` | test | `packages/extensions/ecpay/test/provider.test.ts`, `tests/unit/ecpay-callback-http.test.ts` | SW-115 payment and callback behavior remains covered |

## Current status

SW-116 local implementation is complete. The adapter is explicitly disabled by default and selects only the documented legacy AIO production contract when `creditRefund.mode=aio-production`, production is selected, card checkout is enabled, and `ECPAY_CREDIT_CHECK_CODE` is present. Public ECPay documentation describes multiple products and does not establish which capability this merchant account has enabled; the separate staging/UAT release gate remains blocked until merchant evidence is supplied.

- `pnpm typecheck` — passed.
- `pnpm exec vitest run --project unit packages/extensions/ecpay/test/provider.test.ts tests/unit/ecpay-callback-http.test.ts` — 2 files, 32 tests passed.
- Independent Sol/high design review — confirmed that implementing a mocked success without the merchant contract would fabricate refund readiness.

## Decisions during implementation

* The adapter uses the official legacy AIO production endpoints only; the separate POS API is not silently substituted.
* The adapter never retries `DoAction` after a transport-uncertain response. It stores an `indeterminate` ledger state and requires a later query/reconciliation decision because the public contract does not promise idempotency.
* `NeedExtraPaidInfo=Y` is added only when the explicit refund mode is enabled, preserving existing checkout behaviour while ensuring the callback can persist `gwsr` for refund queries.
