# Acceptance Criteria

## Happy Path

* [x] AC-001: Commerce server, worker, Admin, and CLI projections resolve from the Commerce ReleaseDefinition.
* [x] AC-002: Frozen Commerce contract checks and SW-102 verify that the public contracts and selected release metadata are unchanged.

## Failure Cases

* [x] AC-003: An incomplete or duplicate Commerce contribution is rejected at assembly time.

## Regression Requirements

* [x] AC-004: Existing Commerce configuration and migration compatibility checks pass unchanged.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | Commerce release contract test | all target projections resolve, and the full Commerce Admin contribution matches its independent pre-projection contract |
| `AC-002` | test | Commerce release contract test, B17 structural/semantic contract tests, and SW-102 build baseline | Commerce identity and selection match the legacy release, frozen public contracts remain unchanged, and projection graphs are deterministic |
| `AC-003` | test | invalid Commerce definition fixture | actionable assembly failure |
| `AC-004` | integration | `cli-json-output`, `release-artifacts`, and `migration-history` suites in the `make verify` integration stage | Commerce config, artifact, and migration compatibility retained |

## Execution Evidence

* `pnpm exec vitest run --project unit packages/releases/commerce/test/commerce-release.test.ts` — independently rerun on 2026-09-21: 1 file, 10 tests passed. It covers all target projections, the full frozen Admin contribution, Commerce product identity, legacy CLI release plus seed, the storefront theme asset path, and missing/duplicate/mismatched contributions rejected before factory execution.
* `pnpm typecheck` — passed. `pnpm typecheck:admin` — passed for both the Admin app and the Commerce browser-only Admin projection.
* `pnpm exec tsx scripts/b17-public-contract-semantic.ts --check` — independently rerun on 2026-09-21 and passed. The artifact SHA-256 is `6c1a5df54738b7ab706d0a0091dfda8c9aa0e9eab343f03237fdf5f8820a1a88`; the SW-102 projection baseline records the same hash. The Commerce release contract test separately compares the normalized semantic contract to its frozen pre-projection digest.
* `pnpm exec vitest run --project unit tests/architecture/release-baseline.test.ts` — independently rerun on 2026-09-21: 1 file, 4 tests passed. SW-102 verifies deterministic current projection graphs and release metadata; the Commerce contract test separately compares product identity/selection to the legacy release and public contract inputs to their frozen pre-projection hashes.
* `make verify` — passed on 2026-09-21 on the current worktree after all SW-105 implementation changes: both typechecks; unit (134 files / 1,410 tests); admin (32 files / 351 tests); integration (110 files / 923 tests). This includes the Commerce release contract, configuration, build artifact, CLI JSON, and migration-history coverage.
* `git diff --check` — passed after the acceptance update.
* Independent Sol/high Spec review — PASS with no material findings on 2026-09-21. Independent Sol/high Standards review found an unused Base navigation copy in the Commerce release; it was removed, and the same reviewer rechecked the delta with PASS. The review fixed point was `804adf5a7ea3284ba451a1ac6faf67a8dddcbbc5` (SW-102 baseline); both reviewers isolated the Commerce release package from later stories in the shared worktree.
* Independent current-state Sol/high review — PASS with no material SW-105 findings on 2026-09-22. It rechecked Commerce module/navigation parity, all six projection keys, exact frozen Admin contribution, public-contract and B01 baselines, factory validation, and target source isolation while excluding later-story changes.
* Current-state `make verify` — passed on 2026-09-22: backend and Admin typechecks; unit 137 files / 1,419 tests; Admin 32 files / 351 tests; integration 111 files / 940 tests. This rerun includes `release-artifacts`, `cli-json-output`, `migration-history`, and the Commerce HTTP/MCP regression suites.
* Current-state focused checks — Commerce release contract and SW-102 release baseline: 2 files / 14 tests passed; `pnpm typecheck:admin`, `pnpm exec tsx scripts/b17-public-contract-semantic.ts --check`, and `git diff --check` passed.
* Independent current-state Sol/high Spec review — PASS with no material requirement or scope findings; it verified the release sources, six projection keys, frozen Admin contribution, compatibility checks, and invalid-contribution preflight.
* Independent current-state Sol/high Standards review — PASS with no material documented-standard breach or code smell findings; later-story changes were excluded from the review boundary.
