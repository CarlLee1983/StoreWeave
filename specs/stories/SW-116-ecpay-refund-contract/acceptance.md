# Acceptance Criteria

## Happy Path

* [ ] AC-001: ECPay passes local shared refund-contract success and correlation cases.
* [x] AC-002: A release-gate evidence record explicitly requires ECPay staging refund UAT and names the evidence needed to clear it; this local Story does not assert UAT completion.

## Failure Cases

* [ ] AC-003: Rejected, duplicate, unknown, timeout, and provider-failed refunds remain auditable non-success results.

## Regression Requirements

* [x] AC-004: ECPay payment initiation and callback behavior from SW-115 remains unchanged.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | ECPay refund contract suite | Blocked: Ticket 64 still lacks the merchant-enabled product contract; no fake success path was added. |
| `AC-002` | document review | [staging-uat-evidence.md](staging-uat-evidence.md) | required contract fields and staging cases are documented; UAT remains uncleared |
| `AC-003` | test | ECPay refund failure fixtures | Blocked with AC-001 because outcome and recovery semantics depend on the missing provider contract. |
| `AC-004` | test | `packages/extensions/ecpay/test/provider.test.ts`, `tests/unit/ecpay-callback-http.test.ts` | SW-115 payment and callback behavior remains covered |

## Current status

SW-116 is partially complete. AC-001 and AC-003 remain blocked until the merchant-approved ECPay refund product, endpoint, reference/signature rules, replay semantics, and timeout query/reconciliation contract are supplied. Public ECPay documentation describes multiple products and does not establish which capability this merchant account has enabled. ECPay remains `unsupported` and performs no refund network request.

- `pnpm exec vitest run --project unit packages/extensions/ecpay/test/provider.test.ts tests/unit/ecpay-callback-http.test.ts` — 2 files, 25 tests passed for AC-004.
- Independent Sol/high design review — confirmed that implementing a mocked success without the merchant contract would fabricate refund readiness.
