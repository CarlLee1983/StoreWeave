# Acceptance Criteria

## Happy Path

* [x] AC-001: Authorized operator can use the Booking Admin contribution to manage the one Property and Room Type facts/Media references.

## Business Rules

* [x] AC-002: Room Type uses `max_occupancy_per_unit`; Media remains a Base Media reference and Content is not used as room facts.
* [x] AC-003: Direct routes are backend-authorized independently of navigation visibility.

## Failure Cases

* [x] AC-004: Invalid timezone/currency/occupancy/Media, duplicate Room Type, missing Property, and unauthorized access are safely rejected.

## Regression Requirements

* [x] AC-005: Admin browser bundle contains no DB/Nest/migration code and no Commerce route changes.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | mounted Admin route test and operator HTTP integration | `packages/booking/property/test/admin.test.ts`, `tests/integration/booking-public-http.test.ts` | isolated contribution fixture and operator session | Property create and Room Type edit invoke explicit capabilities; release selection follows in SW-143 |
| `AC-002` | mounted Admin form and domain integration tests | `packages/booking/property/test/admin.test.ts`, `tests/integration/booking-property.test.ts` | Room Type facts and Base Media reference | `maxOccupancyPerUnit` maps to `max_occupancy_per_unit`; only Media asset UUID is stored |
| `AC-003` | direct-URL integration test | `tests/integration/booking-public-http.test.ts` | non-authorized operator session | Property and Room Type API URLs return 403 regardless of navigation |
| `AC-004` | operator HTTP and domain integration tests | `tests/integration/booking-public-http.test.ts`, `tests/integration/booking-property.test.ts` | malformed/conflicting inputs and missing records | validation, conflict, not-found, and forbidden outcomes |
| `AC-005` | browser bundle graph and diff checks | `tests/architecture/booking-property-admin-artifact.test.ts`, `git diff -- packages/releases/commerce apps/admin` | built contribution entry | no forbidden browser import or Commerce route edit |
