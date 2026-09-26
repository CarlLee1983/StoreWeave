# SW-159 — Booking refund reconciliation schedule contract

## Goal and authority

Fix the Booking-owned scheduled refund job defect found while verifying issue #46, Spec 0011 §9.1. The user's request to complete remaining issues authorizes this local implementation and tests; no commit, push, deployment or external payment operation is authorized.

## Boundary and evidence

`booking.reservation.reconcile-refunds` declares an hourly interval. The scheduler produces `{bucket, scheduledFor}`, but its strict v1 payload accepted only `{}`. The worker therefore quarantines scheduled occurrences before calling reconciliation. Direct command tests did not cover this path. Sol/high analysis confirmed the scheduler → queue → version decoder → worker boundary.

Only the Booking Reservation job payload and focused tests change. Keep the scheduler and generic module checker intact. Accept the strict interval payload and preserve the previously valid empty v1 payload for already queued/manual jobs. Invalid partial or extra fields remain invalid. No migration, provider call, or refund policy change is needed.

## Acceptance

- [x] The actual declared interval produces a payload accepted by the job's versioned contract.
- [x] A PostgreSQL queued occurrence runs through the real Worker decoder and enqueues missing refund jobs without quarantine or starvation by a dead oldest refund.
- [x] Existing empty v1 payloads remain readable; malformed payloads are rejected.
- [x] Focused checks, independent Sol/high review and `make verify` pass.

## Focused verification

Payload unit checks: 7/7 passed (`/tmp/storeweave-sw159-unit.log`). Real scheduled Worker reconciliation: 1 passed, 65 skipped (`/tmp/storeweave-sw159-integration.log`). Root typecheck passed. Independent Sol/high review traced the scheduler, version decoder and handler and found no material issue. Full `make verify` passed at SW-146 checkpoint 4, including the complete 66-case Booking Reservation suite; source identity and counts are recorded there.

## Operations and rollback

Do not erase existing quarantined occurrences or their evidence. After deployment, the next hourly occurrence can reconcile pending refunds; operational replay remains an explicit operator action. Reverting the schema reintroduces quarantine of interval-generated payloads. No data backfill or migration is part of this change.
