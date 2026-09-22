# Acceptance Criteria

## Happy Path

* [x] AC-001: Verified callbacks map `payment_confirmed` to `succeeded`, `payment_info_issued` to non-terminal `awaiting_payment`, and `payment_failed` to `failed`; the first applicable successful Attempt confirms the Reservation and becomes its sole winner.

## Business Rules

* [x] AC-002: Callback replay is idempotent; winning selection, deferred deadline extension, and callback/expiry/cancel outcomes are serialized with lifecycle transitions.
* [x] AC-003: Late and Excess successes are durably classified for full refund without reviving/changing Reservation occupancy.

## Failure Cases

* [x] AC-004: Unknown or unverified callback data and stale callback/expiry/cancel races are rejected or no-op without invalid state mutation.

## Regression Requirements

* [x] AC-005: Callback processing does not implement Provider verification or refund execution.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | verified callback mapping test | confirmed, deferred-info, and failed callback fixtures | exact Attempt-state mapping; winner only for `succeeded` |
| `AC-002` | integration | replay/deadline-extension/cancel/expiry race tests | concurrent transactions | serializable, no double effect |
| `AC-003` | integration | late/excess callback tests | expired/cancelled/confirmed fixtures | evidence queued, no revival |
| `AC-004` | integration | unknown/unverified reference test | invalid callback | recognizable rejection |
| `AC-005` | architecture | package boundary scan | completed package | no Provider/refund implementation |

## Evidence

* `pnpm typecheck` passed.
* `pnpm exec vitest run tests/architecture/booking-reservation-boundaries.test.ts --pool=forks` passed.
* Focused PostgreSQL integration tests passed for exact verified confirmed/info/failed mapping and winner selection, exact and stale callback no-ops, callback deadline extension, excess and late evidence, observed-lock-wait callback-versus-expiry/cancellation outcomes with terminal state and Room Night assertions, PostgreSQL winner-integrity constraints, and system/provider/reference/schema rejection.
