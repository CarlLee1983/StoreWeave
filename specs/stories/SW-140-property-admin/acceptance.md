# Acceptance Criteria

## Happy Path

* [ ] AC-001: Authorized operator can use the Booking Admin contribution to manage the one Property and Room Type facts/Media references.

## Business Rules

* [ ] AC-002: Room Type uses `max_occupancy_per_unit`; Media remains a Base Media reference and Content is not used as room facts.
* [ ] AC-003: Direct routes are backend-authorized independently of navigation visibility.

## Failure Cases

* [ ] AC-004: Invalid timezone/currency/occupancy/Media, duplicate Room Type, missing Property, and unauthorized access are safely rejected.

## Regression Requirements

* [ ] AC-005: Admin browser bundle contains no DB/Nest/migration code and no Commerce route changes.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | admin integration test | Property/Room Type route suite | authorized operator | declared contribution renders and invokes capabilities |
| `AC-002` | integration test | fact/media DTO cases | valid Room Type and Media reference | correct semantic fields and reference only |
| `AC-003` | integration test | direct-URL authorization matrix | hidden nav/non-authorized Actor | backend denies route |
| `AC-004` | integration test | invalid Property/Room Type fixtures | malformed/conflicting inputs | safe validation/not-found/forbidden outcomes |
| `AC-005` | import/diff check | Admin target scan | built Booking Admin contribution | no forbidden bundle import/Commerce route edit |
