# Acceptance Criteria

## Happy Path

* [x] AC-001: Base and Commerce assemble exclusively through ReleaseDefinition projections.
* [x] AC-002: The obsolete bundle contract, compatibility branches, and consumers are removed.

## Failure Cases

* [x] AC-003: A synthetic legacy import fails repository contract/type checks.

## Regression Requirements

* [x] AC-004: Base/Commerce baseline, configuration, HTTP, Admin, worker, CLI, and build checks pass.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `tests/architecture/release-baseline.test.ts` (4), `tests/integration/release-artifacts.test.ts` (6), `tests/integration/base-release.test.ts` (4) | Base, Commerce, and file-requests resolve their selected runtime/build projections and retain release behavior |
| `AC-002` | test/inventory | `tests/architecture/legacy-bundle-removal.test.ts` (2); source roots `apps`, `packages`, `scripts`, `tests`, `tools`; Dockerfile | no retired package, import, Docker entry, or compatibility branch remains |
| `AC-003` | test | `tests/architecture/legacy-bundle-removal.test.ts`, synthetic TypeScript resolution | `@storeweave/bundle` cannot resolve from a synthetic consumer |
| `AC-004` | command | `make verify` | root/Admin typechecks pass; unit 121 files / 1,356 tests, admin 32 / 351, integration 108 / 910; CLI upgrade, Base/Commerce HTTP/runtime, Admin, worker, and release artifact checks pass |
