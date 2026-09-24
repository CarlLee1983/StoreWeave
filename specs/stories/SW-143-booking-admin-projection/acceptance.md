# Acceptance Criteria

## Happy Path

* [ ] AC-001: Booking Admin projection statically composes Property, Availability, and Reservation route/navigation/permission/UI entries into a browser artifact.

## Business Rules

* [ ] AC-002: Contributions are selected by projection, not release-id branch; backend authorization remains the source of route access control.
* [ ] AC-003: Missing or duplicate required contribution is diagnosed by key at build/start.

## Failure Cases

* [ ] AC-004: Target-incompatible import, invalid permission declaration, stale key, and route/UI conflict fail deterministically.

## Regression Requirements

* [ ] AC-005: No server executable import and no Commerce route source is introduced.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | build/integration test | Booking Admin projection fixture | SW-140–SW-142 contributions | browser target resolves all declared entries |
| `AC-002` | architecture test | composition/authorization assertions | built projection + direct routes | no product switch; endpoint still authorizes |
| `AC-003` | build test | missing/duplicate contribution fixtures | omitted/duplicated key | named deterministic diagnostic |
| `AC-004` | build test | invalid projection fixtures | foreign import/permission/conflict | build/start fails |
| `AC-005` | import scan | Admin artifact check | emitted browser artifact | no server/Commerce route source |
