# Acceptance Criteria

## Happy Path

* [ ] AC-001: Repository structural checks prove Base, Commerce, and Booking release artifacts and target projections satisfy the defined isolation rules.

## Business Rules

* [ ] AC-002: Booking artifacts exclude Commerce implementation/tables; target artifacts exclude incompatible executable code; root manifests are metadata-only.
* [ ] AC-003: Common Platform/Base assembly contains no Booking/Commerce behavior branch.

## Failure Cases

* [ ] AC-004: Synthetic forbidden import, product switch, executable manifest member, or Commerce migration/table leakage fails with path and violated rule.

## Regression Requirements

* [ ] AC-005: Checks are read-only and do not refactor product code or weaken existing architecture gates.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | architecture test | release-isolation suite | Base/Commerce/Booking fixtures | all intended artifact rules pass |
| `AC-002` | import/schema scan | target/product manifest assertions | emitted artifacts + clean-start schema | forbidden imports/tables absent |
| `AC-003` | source scan | common assembly branch rule | Platform/Base release sources | no product-name behavior branch |
| `AC-004` | negative architecture test | synthetic violation fixtures | one violation per rule | named path/rule failure |
| `AC-005` | command/diff review | test command and changed-path review | completed Story worktree | read-only checks; tests only |
