# Story: SW-188 Operations seed activates the current Commerce Release

## Status

Approved by the user request to implement issue #127.

## Goal

Make `pnpm seed:ops` use the selected Commerce Release lifecycle before writing operations data, so configured mock providers and extension-owned jobs are available.

## Scope

The operations seed entry point and its direct integration contract only. Require the Release to already be current; do not apply pending migrations from this data-seeding command. Keep configured provider validation strict.

Correct the seed's ERP dead-letter sample to use the registered `demo-erp` job type and its versioned payload contract so the complete seed can finish.

Keep the operations fixture aligned with the current checkout contract and provide every variable required by its lifecycle notification templates.

## Rules

- Activate with `require-current` before any operations data write. A stale or unactivated Release must fail before creating orders.
- Run configured extension setup through the normal Release lifecycle; do not mount providers independently.
- Enqueue the dead-letter example using `ext.demo-erp.push-order` with `{ orderId }`.
- Confirm current catalog prices and the server-derived shipping quote at cart checkout; include `shipmentId` for shipment notifications.
- Give default runs unique idempotency keys even when two invocations start within the same second; an explicitly supplied `SEED_RUN_ID` remains caller-controlled.

## Acceptance

- In an isolated mock-only PostgreSQL environment, basic demo seed followed by operations seed reaches completion, including payment, shipment, refund/RMA and ERP job paths.
- A second operations seed succeeds and creates another batch.
- Missing/current-release activation failures occur before operations writes; no production database or real external provider is used for validation.
- Focused regression coverage and `make verify` pass.
