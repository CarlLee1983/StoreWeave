# Acceptance Criteria

## Happy Path

* [x] AC-001: Repository structural checks prove Base, Commerce, and Booking release artifacts and target projections satisfy the defined isolation rules.

## Business Rules

* [x] AC-002: Booking artifacts exclude Commerce implementation/tables; target artifacts exclude incompatible executable code; root manifests are metadata-only.
* [x] AC-003: Common Platform/Base assembly contains no Booking/Commerce behavior branch.

## Failure Cases

* [x] AC-004: Synthetic forbidden import, product switch, executable manifest member, or Commerce migration/table leakage fails with path and violated rule.

## Regression Requirements

* [x] AC-005: Checks are read-only and do not refactor product code or weaken existing architecture gates.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | architecture test | `tests/architecture/release-isolation.test.ts` (`pnpm vitest run --project unit tests/architecture/release-isolation.test.ts`) | real esbuild/Vite graphs of Base/Commerce/Booking server, worker, cli, seed, admin | R1–R4 checkers on real artifacts report zero violations; anti-vacuity asserts each graph resolves its own selected source and has >3 inputs |
| `AC-002` | import/schema scan | `checkProductIsolation`/`checkTargetIsolation` over real target graphs; `checkBookingSchema` over `buildReleaseManifest(release)` + migration SQL (no DB) | emitted server/worker/cli/seed/admin graphs; Booking/Commerce/Base release manifests | forbidden imports/tables absent; live-DB counterpart stays `tests/integration/booking-clean-start.test.ts` (SW-139) |
| `AC-003` | source scan (TypeScript AST) | `checkProductBranches` over `commonAssemblyFiles()` (Platform/Base/host apps/build scripts/`tools/cli`) | Platform/Base release sources + pinned `tools/cli` known-exception list (issue #97) | no unpinned product-id behavior branch; a stale pinned exception also fails |
| `AC-004` | negative architecture test | `tests/architecture/release-isolation-negative.test.ts` + `tests/architecture/fixtures/sw-144/*` | one synthetic violation fixture per rule (R1 import, R1 schema, R2, R3, R4), through the same checkers as AC-001–003 | each fails with its exact `[Rn] subject: path (reason)` message |
| `AC-005` | command/diff review | `git diff --stat origin/feat/sw-144-release-isolation...HEAD` | completed Story worktree | only `tests/architecture/**`, `specs/stories/SW-144-release-isolation/**` changed; no product code touched, no build/build-projections forbidden-input lists weakened |

Commands run: `pnpm vitest run --project unit tests/architecture/release-isolation-negative.test.ts tests/architecture/release-isolation.test.ts` (14/14 passed), `make typecheck`, `make typecheck-admin`, `make test` (155 files / 1515 tests passed, includes the new suite), `make verify` (background; integration is slow — see PR/commit notes for its result).

Known finding, not fixed here (out of scope — Constraints: tests/fixtures only): `make test-admin`'s `apps/admin/src/pages/OrdersPage.test.tsx` fails on this machine on an unrelated relative-time-formatting assertion; `git status` shows this Story touches no `apps/admin/**` file, so the failure predates this Story and should be filed as its own ticket.
