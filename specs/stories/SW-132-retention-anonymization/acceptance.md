# Acceptance Criteria

## Happy Path

* [x] AC-001: Eligible post-stay Reservations have Booker/Guest PII redacted, Account ownership removed, and management credentials revoked according to required Booking retention configuration.

## Business Rules

* [x] AC-002: Lifecycle, frozen financial facts, payment/refund evidence, and audit evidence remain traceable after redaction.
* [x] AC-003: The job processes bounded batches, durably continues its cursor until the run is drained, is idempotent, and leaves ineligible Reservations unchanged.

## Failure Cases

* [x] AC-004: Missing/invalid policy and before-cutoff or invalid stored-date/timezone cases cause no PII mutation.

## Regression Requirements

* [x] AC-005: Only Reservation-local ownership/access links are removed; no Base Account/global privacy ownership or provider-side deletion is introduced.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | scheduled retention job and post-redaction access tests | eligible stay and a claimed Reservation | fields are NULL, Account link is removed, and old management credential is rejected |
| `AC-002` | integration | post-redaction lifecycle/frozen-terms query plus a real winning Attempt, winner pointer, verified-payment audit, SW-129 cancellation refund header, and worker-recorded immutable refund invocation query | eligible cancelled Reservation with claimed owner, management credential, and preserved payment/refund evidence | frozen Reservation facts, winner pointer, current Attempt, refund header/invocation, and audit evidence remain traceable; Booker PII, ownership, Grant state, and management credential hash are removed |
| `AC-003` | integration | repeat, ineligible, and cursor-continuation drain tests | repeated schedule and more than one batch | one redaction audit per Reservation; continuation cursors persist and no eligible backlog remains |
| `AC-004` | integration | policy/date validation test | missing/invalid policy, day before cutoff, invalid frozen date/timezone | no mutation for invalid or ineligible row |
| `AC-005` | architecture | package dependency scan | completed package | no external ownership expansion |

## Review and Verification Evidence

* Sol/high design review accepted the package-local `daily job → idempotent system command → Reservation repository` seam. It confirmed that redaction, its PII-free audit outcome, and cursor continuation share one transaction. The date evaluator uses BigInt for any positive safe-integer policy; cutoffs beyond the supported four-digit calendar remain ineligible rather than adding an undocumented legal-duration cap.
* Independent Sol/high implementation review — PASS after the delta review. The review found and required a fix for marker reversal: additive migration `0005_reservation_pii_marker_terminal` now prevents changing a non-null anonymization marker, with a PostgreSQL regression that attempts to clear the marker while restoring PII.
* The audit payload records redacted field names plus `ownershipUnlinked` and `managementAccessRevoked`; it contains no prior PII or credential material.
* `pnpm typecheck` — passed after the SW-132 delta.
* Focused unit/architecture checks — 2 files / 7 tests passed, covering retention date boundaries, overflow-safe policy dates, package registration, and module boundary.
* Focused `tests/integration/booking-reservation.test.ts` — 14 tests passed after the delta, including multi-batch cursor drain, fact preservation, access revocation, direct SQL marker-reversal rejection, and operation after redaction.
* `make verify` — passed on 2026-09-22: backend and Admin typechecks; unit 137 files / 1,419 tests; Admin 32 files / 351 tests; integration 111 files / 940 tests.
* AC-002 is covered by the focused PostgreSQL retention fixture: it creates a real winning Attempt, operator cancellation refund header, and provider-worker invocation, then proves the cancelled lifecycle, frozen terms, payment/refund rows, and their audit evidence are unchanged after redaction while Reservation PII and local access state are cleared.
* Focused post-redaction refund-retention integration — passed: `pnpm exec vitest run --project integration tests/integration/booking-reservation.test.ts -t "retains cancelled lifecycle, real refund header and invocation evidence"` (1 passed, 44 skipped).

## Scope Decisions and Evidence Limits

* The deadline is inclusive on the first Property-local calendar date at or after checkout date plus configured retention days. A one-day policy first becomes eligible on the local date after checkout.
* Payment status does not override the frozen-date cutoff: an otherwise valid pending-payment Reservation is also redacted once that local date is eligible.
* The redaction set includes the Reservation-local Account link and management access state. It does not delete or mutate the linked Base Account or provider records.
* SW-128 supplies real Reservation winner-selection evidence and SW-129 supplies real refund rows. The post-redaction fixture verifies their linked payment/refund evidence, including an immutable provider invocation, before SW-145 closes the end-to-end retention journey.
