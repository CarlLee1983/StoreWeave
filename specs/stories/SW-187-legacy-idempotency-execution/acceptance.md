# Acceptance

- [x] AC-001: Invalid policy registrations are rejected; unrelated commands retain their behavior.
- [x] AC-002: Owner-first lookup hides foreign hashes, statuses and responses.
- [x] AC-003: Owned old requests cannot create another Order or new scoped claim; changed input and incomplete status refuse safely.
- [x] AC-004: Runtime callbacks that return fail closed, with zero handler calls.
- [x] AC-005: Audit/outbox counts stay unchanged on refusal; PostgreSQL regressions and full make verify pass.

## Evidence

The staged candidate `d08a25b61446d2be68c2e9fe4f063b1915634e99` passed the full `make verify` gate on 2026-10-08: both typechecks, 1,603 unit, 351 admin and 1,078 PostgreSQL integration tests. Commerce Docker 75/75 and native 74/74 smoke checks plus both complete recoveries passed. Independent architect and reviewer accepted the implementation.

See [complete evidence](../SW-185-direct-order-confirmation/verification.md) for commands, environment, exact source tree, focused results and the prior storage failure. The new seed inputs created two correctly confirmed home-delivery orders; full operations seeding remains blocked by preexisting [#127](https://github.com/CarlLee1983/StoreWeave/issues/127), which is outside this change.
