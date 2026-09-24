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
| `AC-004` | negative architecture test | `tests/architecture/release-isolation-negative.test.ts` + `tests/architecture/fixtures/sw-144/*` | one synthetic violation fixture per rule, incl. R1 import, R1 schema (Commerce-owned owner/relation), R1 migration SQL (Commerce/non-allowlisted table), R2 server/worker/admin (React, HTTP controller, Nest/DB/migration/secret/provider), R3 (literal, key, switch/case, `Set.has`, identifier-bound array, `??` default, stale exception, exception-count overflow), R4 — through the same checkers as AC-001–003 | each fails with its exact `[Rn] subject: path (reason)` message |
| `AC-005` | command/diff review | `git diff --stat origin/main...HEAD` | completed Story worktree | only `tests/architecture/**`, `specs/stories/SW-144-release-isolation/**` changed (23 files, 1029 insertions, 10 deletions); no product code touched, no build/build-projections forbidden-input lists weakened |

Commands run and results (verified on this machine, not claimed from an earlier record):
- `pnpm vitest run --project unit tests/architecture/release-isolation-negative.test.ts tests/architecture/release-isolation.test.ts` — 22/22 passed (includes the full real `R3_KNOWN_EXCEPTIONS` table checked against `commonAssemblyFiles()` inside the positive suite's own R3 test — a wrong pinned count or a moved snippet fails that test, not a separate reimplementation of the AST scan).
- `make typecheck`, `make typecheck-admin` — pass.
- `make test` (unit project) — 155 files / 1523 tests passed, includes the new suite.
- `make verify` does **not** pass end-to-end and this Story does not claim it does: it runs `typecheck → typecheck-admin → test → test-admin → test-integration` in order and stops at the first non-zero step, which is `test-admin`. `apps/admin/src/pages/OrdersPage.test.tsx` (`以 zh-TW 顯示 JSON 日期與 awaiting_payment`) fails on this machine on a relative-time-formatting assertion; reviewer-verified to reproduce identically on a clean checkout of `origin/main` (0434cf4), confirming it predates this Story — tracked as issue #101, not fixed here (Constraints: tests/fixtures only, no product code changes). `make verify` therefore never reaches `test-integration` in this Story's run.
- `test-integration` run directly (not through `make verify`, since it stops earlier, on this worktree): 1001/1004 passed, including all 5 cases of `tests/integration/booking-clean-start.test.ts` (SW-139's live-DB counterpart to this Story's static R1 schema check). The 3 failures (`booking-reservation.test.ts` ×1, `cache-and-mutex.test.ts` ×2) are timing/concurrency-sensitive tests unrelated to this diff — reviewer-verified: each passes 62/62 in isolation on both `origin/main` and this branch, and fails only under the full-suite run's resource contention, not as a regression this Story introduces.
