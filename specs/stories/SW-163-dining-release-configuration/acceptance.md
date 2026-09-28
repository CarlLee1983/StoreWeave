# SW-163 Acceptance

## Criteria

- [x] AC-001: Missing, zero, negative, fractional, or invalid retention days fails configuration validation.
- [x] AC-002: Both source and recipient limits and windows are required positive integers; absent or invalid values prevent the public request entrance from starting.
- [x] AC-003: A valid configuration is available to Dining without an implicit retention value; existing release configuration remains unaffected.

## Evidence to collect

`pnpm vitest run --project unit packages/releases/dining/test/dining-config.test.ts`
passed 12/12. Tests parse through the public `@storeweave/release-dining/config`
subpath, cover a valid Dining policy, and reject missing, zero, negative, fractional,
string, unsafe, `NaN`, and infinite values for retention, source and recipient limits,
and both windows. They also reject missing or misspelled nested controls. The parser
requires these values before a future public entry can use them; a live Dining endpoint
is outside this Story.

`pnpm typecheck` passed. The package manifest, TypeScript path, lockfile importer, and
Dockerfile manifest COPY make the config package resolvable without selecting a Dining
Release. The B17 semantic artifact and SW-102 baseline changed only checksums derived
from the new lockfile importer; their focused tests passed 10/10, 2/2, and 4/4.

Full `make verify` passed: backend and Admin typechecks, unit 1589/1589 (159 files),
Admin 351/351 (32 files), and integration 1036/1036 (115 files). Log:
`/tmp/storeweave-sw163-verify-final.log`. Independent standards and spec reviews,
including the Dockerfile and checksum deltas, found no material findings.
