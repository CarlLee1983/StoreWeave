# Acceptance Criteria

## Happy Path

* [x] AC-001: A valid issued Grant is redeemed once into a management credential that authorizes its Reservation.

## Business Rules

* [x] AC-002: Signature, purpose, expiry, generation, and nonce are all validated; only a token hash persists.
* [x] AC-003: Reissue revokes prior Grants and management credentials; a Grant alone cannot operate a Reservation.

## Failure Cases

* [x] AC-004: Tampered, expired, replayed, wrong-purpose, or superseded Grants are rejected.

## Regression Requirements

* [x] AC-005: Reservation number plus Email never authorizes access; raw token is absent from persisted/loggable outputs.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `redeems a signed Access Grant once and stores only a hash for management authorization` in `tests/integration/booking-reservation.test.ts` | eligible Reservation | one redemption yields authorization for that Reservation |
| `AC-002` | integration | successful flow plus claim matrix in `rejects invalid, expired, wrong-purpose, replayed, and superseded Access Grants` | purpose variant and expired signed claims each match their fixture; malformed, wrong-generation, and wrong-nonce variants | signature, purpose, expiry, generation, nonce verified; only hash stored |
| `AC-003` | integration | `reissue revokes an existing management credential` and pre-redemption replacement in the negative matrix | old Grant and credential | prior material denied after generation changes |
| `AC-004` | integration | negative Grant matrix | tampered, expired, replayed, wrong-purpose, superseded, malformed, wrong-generation, and wrong-nonce variants | all rejected as `UNAUTHENTICATED` |
| `AC-005` | security test | successful-flow persistence scan and invalid management-credential checks | Reservation number/Email string, Grant, and returned credential | number/Email and Grant denied; raw Grant and management credential absent from Reservation, idempotency, audit, outbox, and job storage |

## Review and Verification

* Independent Sol/high security review: PASS; the final delta review found no material findings.
* Focused Reservation PostgreSQL integration: 8/8 passed.
* `make verify` passed on 2026-09-22: backend and Admin type checks, unit 136 files / 1,414 tests, Admin 32 files / 351 tests, and integration 111 files / 931 tests.
