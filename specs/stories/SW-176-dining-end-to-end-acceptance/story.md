# SW-176 — Dining end-to-end acceptance

## Goal

Prove all eight Spec 0012 acceptance scenarios across a clean Dining database and the assembled release.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). This is a proposed tests-only implementation unit; implementation and Git/external writes require their own authorization.

- Owning scope: repository integration and release acceptance tests, following the tests-only precedent in SW-145. Product package fixes belong to their owning Stories.
- In scope: Add clean-PostgreSQL tests that exercise public HTTP, operator HTTP/Admin contracts, Dining commands, Notification/Mail, worker retention, and Release selection. Preserve existing release regression coverage and record exact evidence for Spec 0012 §6 scenarios 1–8.
- Out of scope: Product feature implementation, production deployment, real customer data migration, and unrelated test refactors.

## Dependencies

SW-175 and, through it, SW-160–SW-174.

## Risk and constraints

High: the acceptance path crosses persistent data, concurrency, privacy, and shared Base capabilities. Use a clean Dining database and deterministic time/transport fixtures. A failing scenario is an implementation defect until evidence shows the test expectation is wrong; do not weaken Spec 0012 or its tests to obtain a pass. Anonymized data must never be restored by rollback.

## Verification

Run the new clean-database integration suite and `make verify`. Record test names, results, and independent review evidence in [acceptance.md](acceptance.md) when implemented.
