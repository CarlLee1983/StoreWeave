# Story: SW-186 Legacy idempotency policy declaration

## Goal

Declare the opt-in legacy idempotency guard in `packages/platform/contracts` for SW-185 / issue #125. Execution belongs to SW-187.

## Scope

Only Platform contracts: typed exact-old-input projection plus a non-returning historical-response refusal callback, exposed through `CommandDescriptor` and `defineCommand`. No commerce DTO, namespace implementation, database operation or handler execution belongs here. Existing descriptors need not opt in.

## Rules

The input projection uses parsed input; the callback receives the cached response only after the execution boundary checks ownership, hash and status. Runtime enforcement must fail closed even if JavaScript violates the declared `never` callback type (SW-187).

## Acceptance boundary

Backend typecheck and the concrete direct-order/legacy integration probes validate descriptor propagation; the complete gate must pass. No dependencies or schema migrations.
