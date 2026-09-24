# Acceptance Criteria

## Happy Path

* [x] AC-001: Base and Commerce commands are discovered through CLI projections.
* [x] AC-002: Existing Commerce command invocation and config behavior remain compatible.

## Failure Cases

* [x] AC-003: Duplicate or missing CLI contribution errors name the command and release.

## Regression Requirements

* [x] AC-004: CLI import scan excludes browser and server-only executable source.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `packages/releases/{base,commerce}/test/*release.test.ts`, `tests/architecture/cli-projection-imports.test.ts` | selected command help and dispatch |
| `AC-002` | test | existing Commerce CLI suite, `tests/unit/cli-paths.test.ts` | command and projected config/path behavior preserved |
| `AC-003` | test | `packages/platform/release/test/release-definition.test.ts` | mismatched release, duplicate, and missing contributions fail with context |
| `AC-004` | test | `tests/architecture/cli-projection-imports.test.ts` | both target graphs exclude React, Admin, API, Worker, and server/admin projection code |
