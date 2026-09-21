# Acceptance Criteria

## Happy Path

* [x] AC-001: An operator can create the sole Property and active Room Types with structured lodging facts and Media references.

## Business Rules

* [x] AC-002: Room Type occupancy remains distinct from future Room Night sellable units.
* [x] AC-003: Property timezone, single currency, check-in/out times, and default policy are returned through the module capability.

## Failure Cases

* [x] AC-004: A second Property or invalid Property/Room Type data is rejected without persistence.

## Regression Requirements

* [x] AC-005: No Commerce, Media-byte, or Content ownership is introduced.

## Workspace and build integration

* [x] AC-006: The package is included by the frozen pnpm workspace install, root TypeScript alias, and Docker builder manifest.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `tests/integration/booking-property.test.ts` (1, 3) | clean Booking PostgreSQL database | sole Property and active Room Type facts persist; ready Media references attach |
| `AC-002` | unit/architecture | `packages/booking/property/test/types.test.ts` (3); `tests/architecture/booking-property-boundaries.test.ts` (2) | occupancy and migration fixtures | sellable inventory and nightly pricing are excluded |
| `AC-003` | integration | `tests/integration/booking-property.test.ts` (1) | configured Property | read capability returns timezone, currency, times, and default policy |
| `AC-004` | integration | `tests/integration/booking-property.test.ts` (2, 3) | duplicate, malformed, and unknown Media inputs | commands reject and persisted rows/references remain unchanged |
| `AC-005` | architecture | `tests/architecture/booking-property-boundaries.test.ts` (2) | module source and migration scan | only Booking Property/Room Type tables are owned; no Commerce, Content, or Media-byte ownership/import |
| `AC-006` | command/test | frozen lockfile install, `tests/architecture/booking-property-boundaries.test.ts` (1), `tests/unit/dockerfile-workspaces.test.ts` (2) | root workspace/package configuration | TypeScript resolves the package alias; frozen install and Docker builder include the package manifest |

## Verification

- `make verify` — passed: root and Admin typechecks; unit 121 files / 1,356 tests; admin 32 files / 351 tests; integration 108 files / 910 tests.
- Focused Booking Property PostgreSQL integration — 3/3 passed.
- Frozen lockfile install — passed.

## Contract decisions

* `defaultPolicy.freeCancellationHoursBeforeCheckIn` is required, integer hours in `[0, 8760]`; the Property module stores and returns it without executing refunds.
* Room Type `code` is unique and immutable after creation. Stay limits are `minimumStayNights` and optional `maximumStayNights`, both within `[1, 30]`.
* The root integration project already includes `tests/integration/**/*.test.ts`; no duplicate Vitest include is needed.
