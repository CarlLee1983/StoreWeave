# Acceptance Criteria

## Happy Path

* [x] AC-001: Booking Admin projection statically composes Property, Availability, and Reservation route/navigation/permission/UI entries into a browser artifact.

## Business Rules

* [x] AC-002: Contributions are selected by projection, not release-id branch; backend authorization remains the source of route access control.
* [x] AC-003: Missing or duplicate required contribution is diagnosed by key at build/start.

## Failure Cases

* [x] AC-004: Target-incompatible import, invalid permission declaration, stale key, and route/UI conflict fail deterministically.

## Regression Requirements

* [x] AC-005: No server executable import and no Commerce route source is introduced.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | build/integration test | `tests/architecture/booking-admin-projection.test.ts`; `STOREWEAVE_RELEASE=booking pnpm build:admin` | SW-140–SW-142 contributions | browser target resolves all declared entries |
| `AC-002` | architecture test | `booking-release-boundaries.test.ts`; existing Booking endpoint authorization tests | built projection + direct routes | no product switch; endpoint still authorizes |
| `AC-003` | build test | `booking-admin-projection.test.ts` missing/duplicate cases | omitted/duplicated key | named deterministic diagnostic |
| `AC-004` | build test | `booking-admin-projection.test.ts` invalid key/permission/route/UI/import cases | foreign import/permission/conflict | build/start fails |
| `AC-005` | import scan | `booking-admin-projection.test.ts` Vite graph and release graph validator | emitted browser artifact | no server/Commerce route source |

Booking release Admin projection and its contributions are typechecked by `pnpm typecheck:admin` via `packages/releases/booking/tsconfig.admin.json`. The shared Admin shell remains typechecked with the Commerce selection; this gate does not typecheck the shell under the Booking selection.
