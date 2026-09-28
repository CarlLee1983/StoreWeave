# SW-165 Acceptance

## Criteria

- [x] AC-001: A 18:00–19:30 reservation frees its seat at 19:30; overlapping intervals cannot reuse the same table-type unit.
- [x] AC-002: The smallest fitting available type is selected, then larger fitting types; one reservation never combines tables.
- [x] AC-003: Reducing count, disabling a type, or changing capacity fails when any not-yet-ended accepted interval would become invalid.
- [x] AC-004: The capacity commitment operation and supply/closure edits share a serialization rule; concurrent calls cannot oversell or commit a now-closed start. SW-167 applies this operation to operator acceptance.
- [x] AC-005: Closing a future start succeeds even when reservations are already accepted; they keep their capacity commitment until individually cancelled, while pending requests at that start become unacceptably closed. Completed reservations do not block valid future changes.
- [x] AC-006: An accepted reservation retains its saved occupancy duration and interval after the venue duration setting changes; new requests use the new duration.

## Evidence to collect

`pnpm typecheck` passed. `pnpm exec vitest run --project integration tests/integration/dining-capacity-commitment.test.ts` passed 5/5 PostgreSQL tests:

- `uses half-open intervals, selects the smallest available type, and keeps historical snapshots` — exact end/start reuse, larger-type fallback, midnight, cancellation release, saved duration and table capacity.
- `blocks invalid supply edits, but closure leaves accepted commitments in place` — count, capacity, disablement, accepted-versus-pending closure behavior.
- `serializes competing acceptances and settings edits on the venue row` — two acceptances, count reduction, and cancellation against reduction with observed PostgreSQL lock waits.
- `uses peak simultaneous occupancy for overlapping chains` — successive intervals intersecting a candidate without triple simultaneous occupancy.
- `serializes closure against acceptance and permits supply edits after an interval ends` — closure waits for acceptance, pending request becomes closed, completed commitment does not block an edit.

Independent reviewer checked the implementation and test delta. The fixed-date test and timing-only concurrency assertions were corrected; final review found no remaining material issue. Complete repository gate: `make verify` exited 0; typecheck and admin typecheck passed, unit 1597/1597, admin 351/351, integration 1044/1044 (117 files, including both Dining integration files). Full log: `/tmp/storeweave-sw165-verify.log`.
