# SW-108 Verification

## Design and review

- Sol/high design analysis recommended validating every contributed route permission against the selected release's composed module and declared extension permissions. The build preflight uses the existing `PermissionRegistry` and does not run extension setup or include Node-only preflight code in the browser graph.
- Independent Sol/high review found the build selection binding and browser graph checks adequate after remediation. The final delta review found one stale human-facing B17 ledger digest; `docs/base/b17/README.md` now matches the regenerated artifact SHA-256.

## Acceptance evidence

- AC-001: Commerce Admin route, navigation, permission, and UI data are assembled from the selected build-time contribution. Preflight verifies the selected release id, Admin target key, assembled projection, and registered permission keys.
- AC-002: `apps/admin/src/routes.test.ts` asserts the legacy route order, groups, permission declarations, navigation sections, and default route directly.
- AC-003: Assembler and preflight tests reject conflicts, incomplete rows, an unknown permission, and a missing default route before bundling.
- AC-004: The artifact test builds the selected Commerce Vite graph and rejects server, database, migration, secret, and provider implementation imports while allowing provider-neutral SDK contracts and React providers.

## Checks

- `pnpm typecheck` — passed.
- `pnpm typecheck:admin` — passed.
- Focused Admin projection, artifact graph, release manifest, and Commerce tests — 5 files, 35 tests passed.
- B17 semantic ledger and SW-102 release baseline tests — 2 files, 13 tests passed.
- `make verify` — passed: 111 unit files / 1,284 tests, 32 Admin files / 351 tests, and 107 integration files / 904 tests, plus both type checks.

## Boundary

Admin route visibility remains presentation behavior. Backend endpoint authorization semantics were not changed. No Booking Admin pages or runtime plugin registration were added.
