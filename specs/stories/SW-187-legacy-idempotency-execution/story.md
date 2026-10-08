# Story: SW-187 Legacy idempotency execution guard

## Goal

Implement the SW-186 policy at `packages/platform/command-bus` before an actor-scoped claim for SW-185 / issue #125.

## Scope

Command Bus only. Commerce supplies the old-input projection and safe refusal; Platform does not know Order DTOs. Require actor scope and required idempotency at registration.

## Rules

Inside the authorized transaction, inspect the old global `(command, key)` row. Compare Actor before hash, status or response; foreign rows are ignored. Same-actor changed old input mismatches; incomplete status reports in-progress. Completed historical responses invoke the refusal callback. If it unexpectedly returns, throw INTERNAL_ERROR before claiming the new key. No new audit, outbox, key or business state is written by refusal. Non-opt-in commands retain their behavior.

## Dependencies and operations

Depends on SW-186. Legacy rows have no TTL and remain guarded. Drain old writers at cutover: an uncommitted old insert is invisible to the new read. Rollback requires write freeze or compatible writers; no data or schema migration is introduced.
