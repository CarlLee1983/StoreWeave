# Acceptance Criteria

## Happy Path

* [ ] AC-001: Authorized operator can view daily availability and set sellable-unit/price overrides through the Availability Admin contribution.

## Business Rules

* [ ] AC-002: Dates use Property timezone, money uses configured currency/minor units, and UI separates occupancy from inventory fields.
* [ ] AC-003: Reduction below reserved units is rejected by the domain command.

## Failure Cases

* [ ] AC-004: Unauthorized access, invalid date/range/money, missing Room Type, and invalid sellable reduction are observable safe failures.

## Regression Requirements

* [ ] AC-005: The contribution has no direct table access, migration change, or Commerce inventory reuse.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | admin integration test | availability calendar/action suite | authorized operator and Room Type | contribution queries/updates via capability |
| `AC-002` | UI/DTO test | timezone/money/label fixtures | non-UTC Property and configured currency | local dates, integer money, distinct labels |
| `AC-003` | integration test | reserved-unit reduction fixture | Room Night with reservations | domain conflict, no reduction |
| `AC-004` | integration test | invalid access/input matrix | malformed/foreign fixtures | safe rejection |
| `AC-005` | architecture test | contribution import/query scan | Availability Admin source | no direct persistence/Commerce inventory |
