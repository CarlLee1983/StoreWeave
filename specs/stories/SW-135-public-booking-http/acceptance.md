# Acceptance Criteria

## Happy Path

* [x] AC-001: Public Booking routes validate browse/search and Quote requests, create a Reservation only through its capability, initiate payment through its capability, and expose only those explicit public operations.
* [x] AC-002: Payment initiation exposes neither provider secrets nor persistence details and delegates its result to the Reservation payment capability.
* [x] AC-007: Reservation creation presents one `brc1` checkout bearer only through the trusted HTTP adapter; raw bearer material is absent from CommandBus output/idempotency/audit/log/persistence records and the creation response is `Cache-Control: no-store`.
* [x] AC-008: Payment start requires the checkout bearer in its explicit header, authenticates inside the Reservation transaction before method or Reservation disclosure, and all checkout-auth failures are indistinguishable 401s with no Attempt/state drift.
* [x] AC-009: The stored checkout state is additive and hash-only; it shares the initial payment expiry, is deterministic across create idempotency replay, has no legacy pending-Reservation backfill, and revokes atomically on confirm/cancel/expire/anonymize.

## Business Rules

* [x] AC-003: Quote creation reserves no Room Night; stale price/policy returns a replacement Quote and sold-out creation returns unavailable.
* [x] AC-004: Public routes contain no Access Grant redemption, management-cookie/session, Account claim, update, cancellation, or callback behavior.

## Failure Cases

* [x] AC-005: Invalid public inputs and unauthorized payment initiation are rejected without protected Reservation disclosure.

## Regression Requirements

* [x] AC-006: Browser artifacts do not import server/provider/DB code and no generic REST-to-Command endpoint is added.
* [x] AC-010: Concurrent payment starts serialize with one active Attempt; authenticated retry after a failed/expired Attempt remains possible before checkout expiry, while payment/expiry/cancel/confirmation races preserve terminal state and revoke access.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | public Booking HTTP adapter suite | valid browse/search/Quote/create/payment fixtures | explicit routes invoke validated capabilities |
| `AC-002` | integration test | payment-initiation response case | valid public Reservation payment request | capability result only; no provider secret/persistence detail |
| `AC-003` | integration test | Quote mismatch/unavailable cases | changed price/policy and exhausted Room Night | replacement Quote or recognizable unavailable; no Reservation |
| `AC-004` | route inventory test | public route inventory | built public adapter | management and callback operations are absent |
| `AC-005` | integration test | invalid DTO/payment-auth matrix | malformed and unauthorized requests | validation/authorization errors without PII |
| `AC-006` | architecture test | target import and route inventory | built public adapter | no forbidden import or generic command route |
| `AC-007` | integration + storage inspection | create/replay response, idempotency, audit, and Reservation row | valid public creation | bearer appears only in no-store adapter response; persisted state contains only verifier/derivation fields |
| `AC-008` | integration auth matrix | missing, malformed, expired, revoked, cross-Reservation, and unknown-ID credential attempts | created Reservation and valid/invalid bearers | same 401, no provider lookup and no Attempt/state change |
| `AC-009` | integration race/idempotency test | create replay, migration inspection, terminal lifecycle transitions | new and legacy pending Reservations | same deterministic bearer per Reservation; no backfill; terminal transitions revoke verifier |
| `AC-010` | integration concurrency test | competing payment, expiry, cancellation, and callback transactions | valid credential and controlled locks | one active Attempt; no post-terminal authorization; valid retry behavior |

## Release Gate

* [ ] External payment-provider UAT is pending. This story verifies the internal public boundary and neutral payment worker handoff only; it does not configure, copy, or expose provider credentials.
