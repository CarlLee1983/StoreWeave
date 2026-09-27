# SW-165 Acceptance

## Criteria

- [ ] AC-001: A 18:00–19:30 reservation frees its seat at 19:30; overlapping intervals cannot reuse the same table-type unit.
- [ ] AC-002: The smallest fitting available type is selected, then larger fitting types; one reservation never combines tables.
- [ ] AC-003: Reducing count, disabling a type, or changing capacity fails when any not-yet-ended accepted interval would become invalid.
- [ ] AC-004: The capacity commitment operation and supply/closure edits share a serialization rule; concurrent calls cannot oversell or commit a now-closed start. SW-167 applies this operation to operator acceptance.
- [ ] AC-005: Closing a future start succeeds even when reservations are already accepted; they keep their capacity commitment until individually cancelled, while pending requests at that start become unacceptably closed. Completed reservations do not block valid future changes.
- [ ] AC-006: An accepted reservation retains its saved occupancy duration and interval after the venue duration setting changes; new requests use the new duration.

## Evidence to collect

PostgreSQL concurrency and interval tests, including midnight and competing settings edits. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
