# Acceptance Criteria

## Happy Path

* [x] AC-001: An authenticated Booker can explicitly claim an existing Reservation after valid managed authorization; the owner and a valid management session can read it, and either can update Booker contact, primary Guest name, or notes through a domain command with audit evidence.

## Business Rules

* [x] AC-002: Ownership is established only by current authenticated identity plus the approved path, never Email equality or client account id.
* [x] AC-003: Owner-scoped reads and operations reject every other Account, while a valid management session can read and update before or after claim.
* [x] AC-004: Contact, primary Guest, and notes updates are auditable; dates, Room Type, room count, and frozen terms remain immutable.

## Failure Cases

* [x] AC-005: Unauthenticated, revoked-token, forged-account-id, Email-only, and cross-Account claims, plus invalid/unauthorized managed reads and mutable-field updates, are denied.

## Regression Requirements

* [x] AC-006: Booker, Guest, and Account remain distinct domain concepts; HTTP endpoints remain out of scope.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | managed claim, owner query, management query, and update command test | valid managed session and authenticated Actor | owner and management reads work; both update paths are audited |
| `AC-002` | security test | user/customer Actor, forged id, and invalid proof matrix | canonical Actor and management credential | only authenticated identity plus valid management proof claims |
| `AC-003` | integration | cross-Account query/update and competing-claim test | claimed Reservation and two Accounts | non-owner is hidden; one concurrent claim wins |
| `AC-004` | integration | mutable-field audit/immutability test | owner and management credential fixtures | field names are audited; immutable fields rejected |
| `AC-005` | integration | invalid/revoked credential claim/read/update tests | missing, malformed, and rotated credentials | denied without ownership link or mutation |
| `AC-006` | architecture | domain schema/contract review | completed package | no role conflation or HTTP surface |

## Scope Decision

SW-131 includes the minimum management-session read query because SW-136 is constrained to the HTTP adapter and requires a redeemed session to read Reservation data. The query validates the SW-130 credential and loads the row inside one transaction; no HTTP routes or adapter logic moved into this package.

## Review and Verification

* [x] Sol/high security review passed with no material findings; its delta review also confirmed the post-claim management read assertion.
* [x] `make verify` passed after the final changes: typecheck and Admin typecheck; unit 136 files / 1,414 tests; Admin 32 files / 351 tests; integration 111 files / 934 tests.

The integration suite also claims Reservations in `confirmed`, `expired`, and `cancelled` states to prove lifecycle status does not restrict claim eligibility.
