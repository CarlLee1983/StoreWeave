# Acceptance Criteria

## Happy Path

* [ ] AC-001: `packages/releases/booking` builds Booking backend/server, worker, storefront, Theme, Extension, CLI, and `booking.yaml` from one ReleaseDefinition.

## Business Rules

* [ ] AC-002: Root manifest is serializable metadata only; executable contributions are target-specific and build-time selected.
* [ ] AC-003: Missing in-scope backend/server, worker, storefront, CLI, Theme, or Extension contribution and an unqualified refund provider fail build/start with named diagnostics.

## Failure Cases

* [ ] AC-004: Invalid config, duplicate contribution, and target-incompatible import fail deterministically.

## Regression Requirements

* [ ] AC-005: No common product-id branch or Commerce implementation dependency is introduced by Booking assembly.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | build/integration test | Booking ReleaseDefinition fixture | complete selected in-scope Booking contributions | each in-scope target projection resolves |
| `AC-002` | architecture test | manifest/projection assertions | emitted Booking manifest | metadata-only root and target executable separation |
| `AC-003` | build test | missing renderer/provider fixtures | remove required selection | build/start fails with missing key/gate |
| `AC-004` | build test | invalid config/duplicate/foreign-import fixtures | synthetic invalid definition | deterministic diagnostic |
| `AC-005` | import scan | product-isolation check | Booking assembly source/artifact | no product branch or Commerce implementation |
