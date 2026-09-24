# SW-110 verification

## Result

Base and Commerce now select a CLI projection at build time. The common CLI registers shared operations, then validates and registers the selected product commands before parsing arguments. Commerce contributes `content:backfill-legacy-media`; Base contributes no product-specific command. Duplicate names, collisions with shared command names, undeclared commands, and missing handlers fail with release/command context.

The selected projection also owns the compatible release IDs, command name, service prefix, filesystem name, config filename, Commerce legacy environment prefix, and the legacy B01 capability. The config filename comes from that release's config projection. The common CLI and service/path helpers no longer branch on release IDs, and a mismatched runtime/CLI pairing fails before parsing commands. Existing Commerce config-file and environment-variable precedence is preserved. The Base CLI projection is also explicitly compatible with the existing `file-requests` build.

## Checks

- `pnpm typecheck` — passed.
- Focused projection, CLI path/service/upgrade, and import-graph tests — passed (48 tests).
- `pnpm exec tsx scripts/b17-public-contract-semantic.ts --check` — passed after refreshing provenance for the changed Platform CLI source.
- SW-102 baseline candidate regenerated and reviewed; only Base/Commerce CLI graph counts/checksums and the semantic artifact digest changed.
- `git diff --check` — passed.
- Full `make verify` — passed: backend/Admin typechecks; unit and architecture (113 files, 1,297 tests); Admin (32 files, 351 tests); integration (107 files, 904 tests).

The CLI graph test bundles both Base and Commerce selections and checks their help output. It rejects React, Admin, API/Worker, and server/Admin target projection sources. Spec 0011 §7 and ADR 0052 permit the CLI runtime to include backend extensions while prohibiting React/Admin imports; the current legacy bootstrap import still brings shared Commerce extension providers into the CLI graph. Removing that legacy assembly is tracked by SW-112, so this test does not claim those shared runtime providers are absent.

## Files and boundaries

- `packages/platform/release/src/cli.ts`: shared command contribution validation.
- `packages/releases/base/src/cli.ts` and `packages/releases/commerce/src/cli.ts`: selected identity and product command contributions.
- `tools/cli/src/main.ts`, `service.ts`, and `paths.ts`: consume selected CLI identity and register validated contributions.
- `scripts/releases.mjs`, `scripts/build.mjs`, `tsconfig.base.json`, and the paired upgrade fixture: wire the selected CLI entry for built and tested artifacts. `file-requests` reuses the Base CLI projection.
- `tests/architecture/cli-projection-imports.test.ts`, `tests/unit/cli-paths.test.ts`, and release projection tests: acceptance evidence.
- B17 semantic provenance and SW-102 release baseline artifacts: regenerated for the changed source and emitted CLI graphs.

No database, configuration schema/value, or migration changes were made.
