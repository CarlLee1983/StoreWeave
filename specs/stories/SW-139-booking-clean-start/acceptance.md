# Acceptance Criteria

## Happy Path

* [x] AC-001: A fresh testcontainer database boots Booking via `booking.yaml`, applies only selected migrations, and starts its selected target.

## Business Rules

* [x] AC-002: Booking bootstrap neither requires nor creates Commerce tables, migrations, config, or implementation imports.

## Failure Cases

* [x] AC-003: Missing/duplicate manifest, wrong database/config, and Commerce migration leakage fail with actionable evidence.

## Regression Requirements

* [x] AC-004: The fixture uses no production database and changes no Commerce migration history.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | `tests/integration/booking-clean-start.test.ts` | empty PostgreSQL testcontainer, built Booking CLI/API, `booking.yaml` | migration ledger matches selected manifest; API `/health/live` returns 200 |
| `AC-002` | schema/import inspection | same test: catalog, ledger and built graph assertions | completed clean start | no Commerce table, migration or implementation import |
| `AC-003` | integration test | same test: negative fixtures | missing/duplicate selection, missing Booking config, nonexistent and Commerce-shaped databases, missing applied Booking migration | named validation or migration failure |
| `AC-004` | test configuration review | same test: isolated container and temporary build/config | test run | disposable database only; no Commerce migration file or history changed |
