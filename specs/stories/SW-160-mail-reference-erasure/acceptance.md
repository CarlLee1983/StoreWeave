# SW-160 Acceptance

## Criteria

- [x] AC-001: A reference-scoped erase removes Mail-owned customer identifiers and content while retaining only non-identifying delivery/dedupe evidence.
- [x] AC-002: A send already queued, claimed, retrying, or unknown cannot emit mail after erase completes, including concurrent send/erase races.
- [x] AC-003: Repeated erasure is safe; pre-existing Base, Commerce, and Booking mail flows still work.

## Evidence to collect

`pnpm typecheck` passed. `pnpm vitest run --project integration tests/integration/mail.test.ts`
passed 9/9, including queued and pre-creation tombstones, blocked in-flight SMTP versus erase,
dead-job error scrubbing and retry fencing, repeated erase, and the existing Mail flows.
`pnpm vitest run --project integration tests/integration/release-artifacts.test.ts`
passed 6/6 after including the new Mail migration in its disposable legacy-history rollback fixture.
`pnpm vitest run --project integration tests/integration/migration-history.test.ts` passed 18/18.
`pnpm vitest run --project unit tests/architecture/b17-public-contract-semantic.test.ts tests/architecture/release-baseline.test.ts`
passed 14/14; reviewed artifact changes are one Mail source fingerprint, two release manifest checksums,
and the resulting Commerce public-contract input checksum. Independent Sol/high review and delta review
found no material findings.

Full `make verify` passed: typecheck, admin typecheck, unit 1577/1577, admin 351/351,
and integration 1036/1036 across 115 files. The full suite includes existing Base, Commerce,
and Booking mail flows. The pre-existing Booking notification drain count failure was resolved in
[ticket 120](../../../docs/tickets/120-booking-notification-drain-failure-count.md). The Mail migration
also required updating the CLI pending count and pinned release-transition list; both affected files
passed focused tests (31/31) and the full gate. Logs:
`/tmp/storeweave-sw160-migration-fixtures.log` and
`/tmp/storeweave-sw160-ticket120-verify-final.log`.
