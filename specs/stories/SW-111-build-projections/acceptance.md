# Acceptance Criteria

## Happy Path

* [x] AC-001: Build produces independently resolvable server, worker, Admin, and CLI projections for Base and Commerce. Base Admin remains disabled per release selection.
* [x] AC-002: Projection metadata is deterministic and attributable to the selected release.

## Failure Cases

* [x] AC-003: Forbidden target imports and unresolved contributions fail an artifact check.

## Regression Requirements

* [x] AC-004: Current Base/Commerce build outputs remain compatible with SW-102 baseline.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | integration and architecture tests | `tests/integration/release-artifacts.test.ts`, `tests/architecture/admin-projection-artifact.test.ts`, `tests/architecture/cli-projection-imports.test.ts` | Base/Commerce server, worker, CLI, and enabled Admin projections resolve independently; Base Admin is marked disabled |
| `AC-002` | tests | SW-102 baseline and Admin provenance cases | release metadata is deterministic; reusable Admin bundles identify the selected release and verify normalized graph and output tree |
| `AC-003` | tests | `tests/architecture/build-projections.test.ts` and release artifact builds | injected cross-target, forbidden provider/Admin, and unresolved contributions fail with release/target/source context |
| `AC-004` | tests | SW-102 baseline and `tests/architecture/native-release-staging.test.ts` | Base/Commerce target graphs retain their baseline fingerprints; native config, smoke, and systemd outputs preserve their existing filenames and contents |
