# Acceptance

- [x] AC-001: Strict price mapping, required home-delivery input and pickup rejection.
- [x] AC-002: Stale price and shipping confirmations reject without Order, reservation or key.
- [x] AC-003: Order delivery and price snapshots freeze; same-key replay and changed-input mismatch work.
- [x] AC-004: Different Customers share raw keys independently; concurrent identical requests create one Order.
- [x] AC-005: Historical owned keys cannot create another Order or falsely apply a new address.
- [x] AC-006: REST, direct Command, seed and smoke callers use the explicit contract.
- [x] AC-007: Full make verify, both Commerce smokes and independent review pass.

## Evidence

The staged candidate `d08a25b61446d2be68c2e9fe4f063b1915634e99` passed the full `make verify` gate on 2026-10-08: both typechecks, 1,603 unit, 351 admin and 1,078 PostgreSQL integration tests. Commerce Docker 75/75 and native 74/74 smoke checks plus both complete recoveries passed. Independent architect and reviewer accepted the implementation.

See [verification.md](verification.md) for commands, environment, exact source tree, focused results and the prior storage failure. The new seed inputs created two correctly confirmed home-delivery orders; full operations seeding remains blocked by preexisting [#127](https://github.com/CarlLee1983/StoreWeave/issues/127), which is outside this change.
