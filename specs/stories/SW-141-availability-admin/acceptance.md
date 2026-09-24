# Acceptance Criteria

## Happy Path

* [x] AC-001: Authorized operator can view daily availability and set sellable-unit/price overrides through the Availability Admin contribution.

## Business Rules

* [x] AC-002: Dates use Property timezone, money uses configured currency/minor units, and UI separates occupancy from inventory fields.
* [x] AC-003: Reduction below reserved units is rejected by the domain command.

## Failure Cases

* [x] AC-004: Unauthorized access, invalid date/range/money, missing Room Type, and invalid sellable reduction are observable safe failures.

## Regression Requirements

* [x] AC-005: The contribution has no direct table access, migration change, or Commerce inventory reuse.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | mounted Admin route test and operator HTTP integration | `packages/booking/availability/test/admin.test.ts`, `tests/integration/booking-public-http.test.ts` | authorized operator and Room Type | contribution reads Availability-owned context and range, then updates through operator capability endpoints; SW-143 selects the release route |
| `AC-002` | UI/DTO test | `packages/booking/availability/test/admin.test.ts` | America/Los_Angeles Property and USD | local dates, integer minor units, distinct sellable/reserved/occupancy labels |
| `AC-003` | integration test | `tests/integration/booking-availability.test.ts` | Room Night with reserved units | domain conflict, no reduction or partial update |
| `AC-004` | operator HTTP and UI tests | `tests/integration/booking-public-http.test.ts`, `packages/booking/availability/test/admin.test.ts`, `tests/integration/booking-availability.test.ts` | unauthorized, malformed, missing, conflicting and out-of-order fixtures | safe rejection, stable retry key, and no stale range displayed |
| `AC-005` | architecture test | `tests/architecture/booking-availability-admin-artifact.test.ts` | bundled Availability Admin entry | no direct persistence, server, or Commerce import |
