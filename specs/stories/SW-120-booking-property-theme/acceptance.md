# Acceptance Criteria

## Happy Path

* [x] AC-001: The Booking Theme renders Property, Room Type list, and Room Type detail declarations.

## Business Rules

* [x] AC-002: Renderers use supplied structured facts and Media references without becoming their source of truth.

## Failure Cases

* [x] AC-003: The Theme contract check identifies each missing required Booking renderer.

## Regression Requirements

* [x] AC-004: The built Theme artifact imports neither Booking backend nor Commerce implementation.
* [x] AC-005: `booking-property` declares the three required public pages and active Property/Room Type read models; incomplete Theme coverage is rejected against the real module declarations.
* [x] AC-006: The Booking Theme resolves through the root TypeScript alias, frozen workspace lockfile, and Docker builder manifest.
* [x] AC-007: Commerce's B17 semantic provenance fingerprints only its selected Theme source and excludes the unselected Booking Theme.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | unit | `packages/themes/booking-default/test/booking-theme.test.ts` (1) | declared Booking pages | each page renders |
| `AC-002` | unit | `packages/themes/booking-default/test/booking-theme.test.ts` (1, 2) | supplied Property, Room Type, and Media reference | output reflects supplied facts, safely renders valid reference, and omits absent/malformed reference |
| `AC-003` | architecture | `packages/themes/booking-default/test/booking-theme.test.ts` (3) | real Booking module with one renderer removed per case | startup contract rejection names each omitted page id |
| `AC-004` | architecture | `packages/themes/booking-default/test/booking-theme.test.ts` (4) | esbuild Theme bundle metafile | no Booking implementation or Commerce package input |
| `AC-005` | unit/integration | `packages/booking/property/test/pages.test.ts` (1–3); `tests/integration/booking-property.test.ts` (1) | real `booking-property` module and PostgreSQL runtime | stable page ids/paths; both new queries enforce public-read permission; disabled/missing Room Types remain hidden |
| `AC-006` | command/architecture | frozen lockfile install; `tests/unit/dockerfile-workspaces.test.ts` (1–2); `tests/architecture/booking-theme-boundaries.test.ts` (1) | root workspace registration | TypeScript resolves the Theme package; Docker and lockfile include its manifest |
| `AC-007` | architecture | `tests/architecture/b17-public-contract-semantic.test.ts` (keeps Commerce provenance scoped to its selected Theme); B17 semantic `--check` | Commerce source inventory | only `packages/themes/default/src` is included; Booking Theme remains outside Commerce provenance |

## Verification

- `pnpm typecheck` — passed.
- Focused unit — 4 files / 10 tests passed, including workspace manifests, Theme alias resolution, Booking page declarations, renderer safety, runtime coverage, and bundle inputs.
- Focused Booking Property PostgreSQL integration — 3/3 passed, including public query authorization and disabled/missing Room Type behavior.
- `pnpm install --lockfile-only --frozen-lockfile --ignore-scripts` — passed.
- B17 semantic provenance — 10/10 focused tests passed, including `--check`; the inventory now follows Commerce's selected Theme source only.
- SW-102 release-baseline candidate — regenerated with `projectReleaseBaseline()`; diff is limited to the changed B17 semantic artifact SHA-256. The full gate will verify the checked-in baseline.
- Full `make verify` — passed: backend and admin typechecks; unit 124 files / 1,365 tests; admin 32 files / 351 tests; integration 108 files / 910 tests.
- `git diff --check` — passed.
