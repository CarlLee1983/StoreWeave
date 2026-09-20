# Acceptance Criteria

## Happy Path

* [x] AC-001: A deterministic repository check records Base and Commerce release identities, selected keys, and public-contract baseline inputs.
* [x] AC-002: The check records the server, worker, admin, and CLI import graph (or current absence) for each existing release.

## Failure Cases

* [x] AC-003: A fixture with a changed public surface or missing target artifact is rejected with an actionable release/target error.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `tests/architecture/release-baseline.test.ts` | Base and Commerce artifact identities, selections, manifests, and contract inputs are deterministic |
| `AC-002` | test | `sw-102-release-baseline.v1.json` target checksums | server, worker, admin, and CLI graphs are attributed to Base or Commerce; Base Admin absence is explicit |
| `AC-003` | test | mutated target and public-contract fixtures | `commerce/cli target` and `commerce/public-contract` errors identify the affected boundary |
