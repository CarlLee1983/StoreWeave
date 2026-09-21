# Acceptance Criteria

## Happy Path

* [x] AC-001: Availability declares required `booking.availability.search` (`GET /booking/search`) and `booking.availability.quote` (`GET /booking/quote`) pages, and the Theme provides both renderers.
* [x] AC-002: An untouched Search page renders its initial form; a valid multi-Room-Type search returns available choices in Property order with each server-produced Quote, or an explicit unavailable state when none remain.

## Business Rules

* [x] AC-003: Search validates common syntax/static constraints before I/O and Property-local horizon before Availability reads; it excludes only Room-Type-specific stay/occupancy mismatches and unavailable supply, shares common request validation, and raises a visible conflict for an eligible Room Type missing its base price.
* [x] AC-004: Quote is recomputed read-only; matching/omitted expected fingerprints render current, changed available terms render refreshed, and unavailable supply wins over fingerprint mismatch.
* [x] AC-005: Theme renders supplied nightly prices, nightly totals, overall total, currency, cancellation policy, and fingerprint without calculating or inferring terms or supply.

## Failure Cases

* [x] AC-006: Tolerant page input delegates semantic validation to Availability and renders recognized validation failures as HTTP 400; not-found, conflict, authorization, and internal failures continue to `platform.error`.

## Regression Requirements

* [x] AC-007: Search and Quote perform no writes or Room Night reservations; the Theme imports page contracts by type only and its built artifact has no runtime Booking implementation or Commerce imports.
* [x] AC-008: Omitting either required Theme renderer causes startup validation to identify the corresponding page ID.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | architecture/integration | Availability page declaration, runtime page collection, and missing-renderer test | both required pages registered | exact ids/routes are collected and missing Theme entries fail startup |
| `AC-002` | page/producer tests | Availability search page and query tests | no query; then several active Room Types with mixed supply | initial form renders; available choices preserve Property order and include complete Quotes |
| `AC-003` | unit/integration | Availability search eligibility tests | mixed min/max stay, occupancy, unavailable supply, and missing base price | only room-specific mismatch/unavailable is excluded; eligible missing price propagates conflict |
| `AC-004` | page/producer tests | Quote page fingerprint-state tests | omitted, matching, mismatching, and unavailable snapshots | current/refreshed/unavailable precedence is exact and no write occurs |
| `AC-005` | Theme tests | renderer fixtures with deliberately non-additive supplied totals | current and refreshed Quotes | exact supplied values and fingerprint appear without recomputation |
| `AC-006` | page/route integration | tolerant query inputs and failure fixtures | empty Search, malformed semantic request, not-found, conflict, authorization/internal errors | initial form and validation 400 are distinct; non-validation errors reach `platform.error` |
| `AC-007` | architecture/artifact test | Theme type imports and bundle metafile | built Theme artifact | no runtime Booking or Commerce implementation input; Availability counts unchanged after page requests |
| `AC-008` | architecture/integration | actual registered page map with each renderer removed in turn | one missing required renderer | startup failure names the missing page id |

## Verification

* `make verify` passed on 2026-09-21: backend and Admin typechecks; unit 134 files / 1410 tests; Admin 32 files / 351 tests; integration 110 files / 923 tests.
* Sol/high design review passed: Availability owns page contracts, data providers, validation, and Quote refresh states; Theme only renders typed models.
* Independent Sol/high code review found that the Search renderer labeled the first-night rate as a minimum. It now says “首晚每房每晚”; the descending-price fixture and test passed. Delta review passed with no further findings.
* Two earlier full-gate attempts exposed unrelated timing failures in the worker fatal-boundary unit test and the full-restore cutover test. Each passed in isolation, and the subsequent full `make verify` passed.
