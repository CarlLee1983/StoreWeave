# Acceptance Criteria

## Happy Path

* [ ] AC-001: A fresh testcontainer database boots Booking via `booking.yaml`, applies only selected migrations, and starts its selected target.

## Business Rules

* [ ] AC-002: Booking bootstrap neither requires nor creates Commerce tables, migrations, config, or implementation imports.

## Failure Cases

* [ ] AC-003: Missing/duplicate manifest, wrong database/config, and Commerce migration leakage fail with actionable evidence.

## Regression Requirements

* [ ] AC-004: The fixture uses no production database and changes no Commerce migration history.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | Booking clean-start test | empty PostgreSQL testcontainer | migrations and target start succeed |
| `AC-002` | schema/import inspection | post-bootstrap catalog + import scan | completed clean start | no Commerce table/migration/import |
| `AC-003` | integration test | negative bootstrap fixtures | invalid manifest/config/leak | named boot failure |
| `AC-004` | test configuration review | integration fixture config | test run | ephemeral database only; no Commerce history change |
