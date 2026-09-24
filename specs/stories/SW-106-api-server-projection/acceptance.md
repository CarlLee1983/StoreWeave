# Acceptance Criteria

## Happy Path

* [x] AC-001: The API host mounts only server-projection adapters for Base and Commerce.
* [x] AC-002: Existing Commerce HTTP routes remain reachable with their prior contract.

## Failure Cases

* [x] AC-003: Duplicate routes and missing required server contributions fail deterministically.

## Regression Requirements

* [x] AC-004: Import scanning proves the server artifact excludes Admin and worker executable source.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | unit | `tests/unit/api-main-catalog.test.ts` (5 tests) | selected release and HTTP adapter reach bootstrap/server through one server projection |
| `AC-002` | integration | `tests/integration/http-catalog-artifact.test.ts` (8 tests), full Commerce HTTP/MCP suite (73 tests) | Base and Commerce route catalogs match; existing HTTP behavior passes |
| `AC-003` | unit + integration | `tests/unit/api-main-catalog.test.ts`; duplicate-route case in `tests/integration/base-http.test.ts` | missing or mismatched adapter fails before bootstrap; duplicate routes identify the owning release |
| `AC-004` | integration | `tests/integration/release-artifacts.test.ts` (4 tests) | Base/Commerce API graphs select only their server projection and exclude Admin/worker executable source |

## Verification

`make verify` passed: typechecks, unit 107 files / 1,254 tests, Admin 32 files / 350 tests, and integration 107 files / 904 tests. The first full attempt exposed that the session-start architecture guard treated the new file-requests server shim as an adapter; the guard now enumerates files that export `httpAdapter`, and the complete rerun passed.

The B17 semantic provenance artifact includes the Commerce server projection and its target definition. Its SHA-256 is `90bc6ed2d71f99c26c7d10486e0d5208675ba87f5dd7f2a28f35489c274ed740`, matching the B17 README and SW-102 baseline fixture.
