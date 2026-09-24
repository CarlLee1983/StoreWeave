# Acceptance Criteria

## Happy Path

* [x] AC-001: ReleaseDefinition declares identity, selected keys, serializable metadata, and target projections through the new public contract.
* [x] AC-002: Existing consumers remain buildable while no consumer has migrated.

## Failure Cases

* [x] AC-003: Contract validation rejects executable/non-serializable root-manifest content and incomplete required projection declarations.

## Regression Requirements

* [x] AC-004: The SW-102 Base/Commerce baseline remains unchanged.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `packages/platform/release` contract tests | definitions resolve each target independently |
| `AC-002` | command | focused typecheck/build | legacy assembly still builds |
| `AC-003` | test | invalid definition fixtures | actionable contract failures |
| `AC-004` | test | SW-102 baseline check | no pre-migration drift |

## Execution Evidence

* `node_modules/.bin/vitest run --project unit packages/platform/release/test/release-definition.test.ts` — passed: 1 file, 13 tests. Root is manifest-only; server, worker, admin, CLI, config, and storefront/theme contributions resolve only through their respective subpaths and every factory key must match its manifest target declaration. Fixtures reject executable/non-serializable metadata, incomplete target declarations, duplicate selected keys, a mismatched Commerce factory for a Base target, and JSON serialization bypasses including an array `toJSON` returning `BigInt`, an executable `4294967295` array property, and `__proto__` data loss.
* `node_modules/.bin/tsc -p tsconfig.json --noEmit` — passed. Legacy consumers remain typecheckable without migration.
* `pnpm install --lockfile-only` — passed. The lockfile contains the expected empty `packages/platform/release` workspace importer only; no package dependencies were introduced.
* `pnpm typecheck` and `pnpm typecheck:admin` — passed. Legacy consumers remain typecheckable without migration.
* `pnpm tsx scripts/b17-public-contract-semantic.ts --output <candidate>` — passed; the checked-in B17 semantic public-contract artifact was regenerated, and its corresponding SW-102 provenance hash was updated.
* `node_modules/.bin/vitest run --project unit tests/architecture/release-baseline.test.ts` — passed: 1 file, 4 tests in 31.67s. The SW-102 Base/Commerce baseline remains unchanged.
* `pnpm test` — passed: 105 files, 1241 tests in 123.89s.
* `make verify` — passed with exit 0: unit 105 files / 1241 tests, admin 32 files / 350 tests, and integration 107 files / 902 tests.
* `git check-ignore -v packages/platform/release/src/index.ts` — passed with no output; the package is no longer ignored. `git diff --check` also passed.
