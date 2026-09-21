# Acceptance Criteria

## Happy Path

* [x] AC-001: Commerce Admin route, navigation, permission, and UI entry resolve from one build-time contribution.
* [x] AC-002: Existing Admin route and permission tests remain behaviorally compatible.

## Failure Cases

* [x] AC-003: Conflicting route or incomplete contribution fixtures fail at assembly.

## Regression Requirements

* [x] AC-004: Browser import scan excludes backend and provider implementation source.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | test | `packages/platform/release/test/admin-projection.test.ts`, `packages/releases/commerce/test/commerce-release.test.ts`, and Admin preflight | Commerce route rows assemble with a matching release target and known permissions |
| `AC-002` | test | `apps/admin/src/routes.test.ts`, `pnpm test:admin` | legacy route order, groups, permissions, filtering, and UI behavior remain compatible |
| `AC-003` | test | Admin assembler and `tests/architecture/admin-projection-preflight.test.ts` | conflicts, incomplete rows, unknown permissions, and missing default route fail before build |
| `AC-004` | test | `tests/architecture/admin-projection-artifact.test.ts` | actual Vite module graph and imports exclude backend, database, migration, secret, and provider implementations |
