# SW-109 Verification

## Implementation

- Added a config-boundary resolver that selects exactly one factory by the selected ReleaseDefinition's `config` target key. The resolved projection carries release id, target key as schema id, schema definition, and default filename.
- Missing or duplicate contributions fail before their resolver runs. The projected loader uses the selected filename within the configured default search directories and prefixes load errors with release and schema ids.
- Existing `loadConfig` and `loadReleaseConfig` entry points remain compatible. Commerce schema values and `commerce.yaml` defaults are unchanged.

## Acceptance evidence

- AC-001: tests select Base and Commerce config contributions through their manifest target keys and assert each schema and filename.
- AC-002: the Commerce config tests retain validation and defaults and assert `commerce.yaml`.
- AC-003: tests cover no selected definition, missing and duplicate contributions, filename-based path selection, and invalid config diagnostics containing the selected release and schema.

## Checks

- `pnpm typecheck` — passed.
- Focused release-config, B17 semantic ledger, and SW-102 baseline checks — 3 files, 24 tests passed.
- `make verify` — passed: 111 unit files / 1,288 tests, 32 Admin files / 351 tests, and 107 integration files / 904 tests, plus both type checks.
- `git diff --check` — passed.

## Boundary

This story changes only the config boundary and its tests. Existing bootstrap and CLI callers keep using the compatible loader path; wiring product config projections into those callers belongs to a later story with that caller boundary in scope. No config schema, values, or deployment files changed.

When no ReleaseDefinition is supplied, the resolver reports that absence directly; it cannot name a release or schema that was not provided. Once a definition is selected, missing contributions and invalid config errors include its release and config target key.
