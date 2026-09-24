# Acceptance Criteria

## Happy Path

* [x] AC-001: After replacing PostgreSQL, native recovery waits for a database
  connection from the release container before it invokes restore.
* [x] AC-002: The readiness probe retains the bounded 60-attempt timeout and
  reports a release-container reachability failure.

## Failure Cases

* [x] AC-003: Regression coverage fails if restore is moved before the
  release-container readiness probe.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | unit test + native smoke | `tests/unit/smoke-evidence.test.ts` (8 passed); `pnpm smoke:native` (passed, 2026-09-20) | cold recovery completed after database replacement; media SHA and pending job were restored |
| `AC-002` | unit test | focused unit test | bounded probe and actionable error remain present |
| `AC-003` | unit test | focused unit test | ordering regression is rejected |
