# Acceptance Criteria

## Happy Path

* [x] AC-001: Base and Commerce workers resolve only their declared worker projections.
* [x] AC-002: Existing Commerce worker regression tests pass unchanged.

## Failure Cases

* [x] AC-003: Missing or wrong-target worker contributions are rejected before startup.

## Regression Requirements

* [x] AC-004: Worker import scan excludes HTTP controllers and Admin UI.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `tests/unit/worker-main.test.ts`; `tests/integration/release-artifacts.test.ts` | Base and Commerce boot through their selected worker projections; bundles contain only their selected worker projection |
| `AC-002` | test | `tests/integration/worker-execution.test.ts`; `tests/integration/job-payload-contract.test.ts`; full `make verify` | existing worker lifecycle and job payload behavior pass unchanged |
| `AC-003` | test | `tests/unit/worker-main.test.ts` | missing and wrong-target projections fail before bootstrap or Worker construction |
| `AC-004` | test | `tests/integration/release-artifacts.test.ts` | Base and Commerce worker graphs exclude API/Admin apps and server/Admin release projections |

## Verification

- Independent SW-107 review: clean after correcting the Base disabled-worker config filename; reviewer delta recheck was clean.
- Focused unit: `tests/unit/worker-main.test.ts` — 6/6 passed.
- Focused integration: `tests/integration/release-artifacts.test.ts` — 4/4 passed.
- `make verify` (2026-09-21): typecheck and Admin typecheck passed; unit 108 files / 1,260 tests, Admin 32 files / 350 tests, integration 107 files / 904 tests; exit 0.
