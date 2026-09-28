# SW-164 Acceptance

## Criteria

- [x] AC-001: Duplicate table types with the same seat capacity are rejected; settings persist and can be read.
- [x] AC-002: A date override fully replaces weekly starts for its start date, including a closed date.
- [x] AC-003: Nonexistent and ambiguous local DST starts are unavailable; cross-midnight starts belong to their start date.
- [x] AC-004: Once a request exists, timezone edits fail; later duration/window changes do not rewrite existing request snapshots.
- [x] AC-005: Setting changes record actor, time, and result without customer contact fields.
- [x] AC-006: The default booking window is at least one hour and at most thirty days before the start; authorized settings may change both bounds for future requests.

## Evidence to collect

Unit timezone/schedule tests plus PostgreSQL command and snapshot tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.

## Implementation evidence

- `packages/dining/reservation` owns one venue, table types, weekly starts, date overrides, and immutable request snapshots. Public submission and accepted-capacity operations remain in later Stories. The internal snapshot insert locks the venue row; the database guards concurrent first-request insertion and timezone edits.
- `pnpm exec vitest run --project unit packages/dining/reservation/test/schedule.test.ts`: 8/8 passed. Covers default and custom booking windows, weekly/override replacement, cross-midnight start dates, and DST gaps/overlaps including a half-hour transition.
- `pnpm exec vitest run --project integration tests/integration/dining-settings-schedule.test.ts`: 3/3 passed. Covers persisted settings and read queries, duplicate capacity, a live override, successful audit actor/time/result, snapshot preservation, future setting changes, direct SQL guards, and concurrent first request versus timezone edit.
- `pnpm typecheck`: passed after module integration. Independent review of the implementation and focused fixes found no remaining material issue.
- `make verify`: exit 0; typecheck and admin typecheck passed, unit 1,597/1,597, admin 351/351, integration 1,039/1,039. Full log: `/tmp/storeweave-sw164-verify.log`.
- Audit evidence applies to successful setting changes. Rejected command attempts roll back in the shared Command Bus and are not themselves setting changes.
- The new migration is additive. Once requests exist, rollback requires a compatible application or forward correction while retaining snapshots; dropping the table would lose request evidence.
