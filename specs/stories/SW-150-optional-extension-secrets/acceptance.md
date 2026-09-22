# Acceptance Criteria

## Happy Path

* [x] AC-001: An Extension with an absent declared optional secret mounts and
  can read it as `undefined`.
* [x] AC-002: An Extension with a present declared optional secret can read its
  value through `ExtensionContext`.

## Failure Cases

* [x] AC-003: Required secrets remain mount-time requirements, overlapping
  required/optional declarations are invalid, and undeclared reads are denied.

## Regression Requirements

* [x] AC-004: Existing required-secret health checks and Extension contracts
  retain their current behaviour; optional declarations do not create a failed
  health check when absent.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | Host integration test | `tests/integration/flow-extension-erp.test.ts` optional-secret fixture without a value | mount succeeds; `ctx.secret()` returns `undefined` |
| `AC-002` | Host integration test | the same fixture with `OPTIONAL_PROBE` provided | declared value is readable |
| `AC-003` | SDK + Host tests | `packages/platform/extension-sdk/test/manifest.test.ts` and Host probe | overlap, missing-required, and undeclared reads fail closed |
| `AC-004` | focused health/contract tests | `tests/unit/health-provider-checks.test.ts`, SDK test context, and release extension contracts | required checks unchanged; absent optional secret is not failed |

## Verification

* `pnpm typecheck` — passed.
* Focused unit checks — 7 files / 74 tests passed, including SDK declaration and
  test-context parity, ECPay extension regression, health, and existing
  secret-using adapters.
* Focused Host integration — `tests/integration/flow-extension-erp.test.ts`:
  1 file / 12 tests passed, including absent/present optional-secret mounting
  and missing-required rejection.
* Independent Sol/high review — found test-context access was initially
  opt-in; the helper now requires an explicit declared-secret list and all
  callers were updated. No other material findings remain.
* `make verify` — passed: unit 138 files / 1,423 tests; admin 32 files / 351
  tests; integration 111 files / 942 tests.
