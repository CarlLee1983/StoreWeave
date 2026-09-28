# SW-166 Acceptance

## Criteria

- [x] AC-001: Only starts with a fitting available table type may be submitted; pending requests do not consume capacity.
- [x] AC-002: The same submission key creates exactly one pending request and number under concurrent retry; a distinct key may create another request.
- [x] AC-003: Invalid contact/party/start/window input or either rate limit creates no request and schedules no receipt.
- [x] AC-004: Stored optional notes are shown verbatim to authorized operators and do not alter table selection.
- [x] AC-005: Rate-limit data expires without retaining recipient identifiers beyond Dining retention.
- [x] AC-006: Party size is the total number of people requiring seats, including infants needing high chairs; no adult/child allocation or joined tables are inferred.

## Evidence to collect

PostgreSQL idempotency/rate-limit tests and available-start boundary tests; source identity is a trusted contract input. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.

## Implementation evidence (2026-09-28)

- `pnpm vitest run --project unit packages/dining/reservation/test/schedule.test.ts`: 9 tests passed. Includes exact minimum/maximum booking-window endpoints, DST invalid/ambiguous starts, and required positive public-request policy limits with cleanup before the retention deadline.
- `pnpm vitest run --project integration tests/integration/dining-public-requests.test.ts tests/integration/dining-settings-schedule.test.ts tests/integration/dining-capacity-commitment.test.ts`: 11 tests passed across 3 files. Public requests cover table fit, occupied capacity, pending requests, concurrent replay, distinct keys, verbatim notes and authorized read, invalid inputs with no request/receipt, both independent limits, hashed rate identities, and expiration. Existing settings and capacity tests cover schedule overrides, snapshots, serialization, and half-open occupancy.
- `pnpm typecheck`: passed after the final rate-count query change. `make verify`: passed on the final source (unit 160 files/1598 tests; Admin 32 files/351 tests; integration 118 files/1047 tests).
- Independent Standards and Spec reviews found and resolved a duplicated capacity rule and a cleanup interval that could run after the Dining retention deadline. Both reviewers cleared the revised delta; the final sequential rate-count query change was also reviewed with no findings.
- The public adapter must supply a stable non-raw `sourceIdentity`, map a fresh UUID v4 submission key into command input, and omit the Command Bus `idempotencyKey` option. A running Dining worker executes hourly rate-event cleanup. These are integration and operational contracts for later release wiring.
