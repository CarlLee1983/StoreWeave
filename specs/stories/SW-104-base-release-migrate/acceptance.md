# Acceptance Criteria

## Happy Path

* [x] AC-001: Base is assembled from its ReleaseDefinition entry point for all currently supported targets.
* [x] AC-002: Base release identity, selected contributions, and public baseline remain equivalent to SW-102.

## Failure Cases

* [x] AC-003: A missing Base-required contribution is reported before a target starts.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | Base release contract test | projections resolve from Base definition |
| `AC-002` | test | SW-102 baseline check | no Base public drift |
| `AC-003` | test | incomplete Base fixture | deterministic missing-contribution error |

## Execution Evidence

* `node_modules/.bin/vitest run --project unit packages/releases/base/test/base-release.test.ts` — passed: 1 file, 5 tests. The manifest's selected module keys are derived from the legacy Base `createModules()` call with its manifest config and provider registry; all six target projections resolve to legacy-equivalent contributions, including explicit disabled Admin and `storeweave.yaml` configuration. Invalid Base selection fails before its factory executes, and a mismatched projection key is rejected.
* `node_modules/.bin/tsc -p tsconfig.json --noEmit` — passed.
* `pnpm install --lockfile-only` — passed. pnpm validates the 55-workspace graph but omits zero-dependency importers, so the expected empty `packages/releases/base` importer was recorded as a narrow lockfile entry.
* `node_modules/.bin/vitest run --project unit tests/architecture/release-baseline.test.ts` — passed: 1 file, 4 tests in 28.48s. The SW-102 Base/Commerce baseline remains unchanged.
* `make verify` — passed with exit 0: unit 106 files / 1246 tests, admin 32 files / 350 tests, and integration 107 files / 902 tests.
* `git diff --check` — passed.
